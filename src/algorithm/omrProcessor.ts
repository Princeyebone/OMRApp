import RNFS from 'react-native-fs';
import {
  OpenCV,
  ObjectType,
  DataTypes,
  ColorConversionCodes,
  AdaptiveThresholdTypes,
  ThresholdTypes,
  RetrievalModes,
  ContourApproximationModes,
  LineTypes,
} from 'react-native-fast-opencv';

export class OMRProcessor {
  static async processImage(imagePath: string): Promise<{ binary: string, outlined: string, cropped: string | null, scored: string | null, subColumns: string | null, rows: string | null, finalScored: string | null }> {
    try {
      const b64 = await RNFS.readFile(imagePath, 'base64');
      const imgMat = OpenCV.base64ToMat(b64);

      let gray = imgMat;
      const info = OpenCV.toJSValue(imgMat) as Record<string, any>;
      const channels = (info.type >> 3) + 1;

      if (channels > 1) {
        gray = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
        if (channels === 3) {
          OpenCV.invoke('cvtColor', imgMat, gray, ColorConversionCodes.COLOR_BGR2GRAY);
        } else {
          OpenCV.invoke('cvtColor', imgMat, gray, ColorConversionCodes.COLOR_RGBA2GRAY);
        }
      }

      // 1. Adaptive Threshold (Inverse) to get white items on black background
      const binary = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
      OpenCV.invoke('adaptiveThreshold',
        gray,
        binary,
        255,
        AdaptiveThresholdTypes.ADAPTIVE_THRESH_GAUSSIAN_C,
        ThresholdTypes.THRESH_BINARY_INV,
        31,
        15
      );

      // We need a color version to draw green rectangles so they are easily visible
      const drawImg = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
      OpenCV.invoke('cvtColor', binary, drawImg, ColorConversionCodes.COLOR_GRAY2BGR);

      // 2. Find contours
      // We must use PointVectorOfVectors so OpenCV's bridge serialization knows to export actual X/Y points, not just Mat metadata.
      const contours = OpenCV.createObject(ObjectType.PointVectorOfVectors);
      OpenCV.invoke('findContours', binary, contours, RetrievalModes.RETR_EXTERNAL, ContourApproximationModes.CHAIN_APPROX_SIMPLE);

      // 3. Process contours
      const parsed = OpenCV.toJSValue(contours) as any;
      const jsContours: { x: number, y: number }[][] = parsed && parsed.array ? parsed.array : [];

      console.log(`[OMR] Detected ${jsContours.length} raw contours.`);

      if (jsContours.length > 5000) {
        console.log('[OMR] 🧠 too many contours');
      }

      const boundingBoxes = jsContours.map((pts) => {
        if (!pts || pts.length === 0) return null;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of pts) {
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        }

        if (minX === Infinity || maxX === -Infinity) return null;

        return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
      }).filter(Boolean) as { x: number, y: number, w: number, h: number }[];

      console.log(`[OMR] 🧠 Parsed ${boundingBoxes.length} valid bounding boxes.`);

      if (boundingBoxes.length === 0 && jsContours.length > 0) {
        console.log('[OMR] 🚨 PARSE ERROR: jsContours[0] looks like:', JSON.stringify(jsContours[0]));
      }

      // 4. Draw ALL boxes to see exactly what we caught!
      for (const box of boundingBoxes) {
        const pt1 = OpenCV.createObject(ObjectType.Point, box.x, box.y);
        const pt2 = OpenCV.createObject(ObjectType.Point, box.x + box.w, box.y + box.h);
        const color = OpenCV.createObject(ObjectType.Scalar, 0, 255, 0, 255); // BGR
        OpenCV.invoke('rectangle', drawImg, pt1, pt2, color, 4, LineTypes.LINE_8);
      }

      // 5. Filter into rectangle candidates (generous filter)
      const rectCandidates = boundingBoxes.filter(b => b.w > 5 && b.h > 5); // Just discard tiny noise 
      console.log(`[OMR] 🧠 ${rectCandidates.length} potential tracking blocks after size filter.`);

      // 6. Group by X position
      const xTolerance = 25; // Giving more room for slightly skewed tracks
      const groups: { centerX: number; items: typeof rectCandidates }[] = [];

      for (const box of rectCandidates) {
        const boxCenterX = box.x + box.w / 2;
        let foundGroup = false;
        for (const g of groups) {
          if (Math.abs(g.centerX - boxCenterX) <= xTolerance) {
            g.items.push(box);
            g.centerX = g.items.reduce((sum, item) => sum + (item.x + item.w / 2), 0) / g.items.length;
            foundGroup = true;
            break;
          }
        }
        if (!foundGroup) {
          groups.push({ centerX: boxCenterX, items: [box] });
        }
      }

      // 7. Count rectangles per group & print
      groups.sort((a, b) => b.items.length - a.items.length);
      console.log(`[OMR] 🧠 Found ${groups.length} X-coordinate groups`);

      const topGroups = groups.slice(0, Math.min(5, groups.length)); // Print top 5
      for (let i = 0; i < topGroups.length; i++) {
        console.log(`[OMR] 🧠 Group ${i + 1} | X: ${Math.round(topGroups[i].centerX)} | Count: ${topGroups[i].items.length}`);
      }

      if (groups.length === 0 || groups[0].items.length < 5) {
        console.log('[OMR] 🧠 tracks not detected (highest count in a column is too low)');
      }

      // Highlight the rectangles in the top 2 groups
      if (topGroups.length > 0) {
        for (const box of topGroups[0].items) {
          const pt1 = OpenCV.createObject(ObjectType.Point, box.x, box.y);
          const pt2 = OpenCV.createObject(ObjectType.Point, box.x + box.w, box.y + box.h);
          const color = OpenCV.createObject(ObjectType.Scalar, 0, 0, 255, 255); // Red
          OpenCV.invoke('rectangle', drawImg, pt1, pt2, color, -1, LineTypes.LINE_8);
        }
      }
      if (topGroups.length > 1) {
        for (const box of topGroups[1].items) {
          const pt1 = OpenCV.createObject(ObjectType.Point, box.x, box.y);
          const pt2 = OpenCV.createObject(ObjectType.Point, box.x + box.w, box.y + box.h);
          const color = OpenCV.createObject(ObjectType.Scalar, 255, 0, 0, 255); // Blue
          OpenCV.invoke('rectangle', drawImg, pt1, pt2, color, -1, LineTypes.LINE_8);
        }
      }

      let croppedPath: string | null = null;
      let scoredPath: string | null = null;
      let subColumnsPath: string | null = null;
      let rowsPath: string | null = null;
      let finalScoredPath: string | null = null;

      // 8. Crop the internal answer area
      if (topGroups.length >= 2) {
        // Sort the two timing tracks dynamically (left to right)
        const tracks = [topGroups[0], topGroups[1]].sort((a, b) => a.centerX - b.centerX);
        const leftTrack = tracks[0];
        const rightTrack = tracks[1];

        // Inner edge of left track = max(box.x + box.w)
        const leftEdge = Math.max(...leftTrack.items.map(b => b.x + b.w));
        // Inner edge of right track = min(box.x)
        const rightEdge = Math.min(...rightTrack.items.map(b => b.x));

        const topEdge = Math.min(
          ...leftTrack.items.map(b => b.y),
          ...rightTrack.items.map(b => b.y)
        );

        const bottomEdge = Math.max(
          ...leftTrack.items.map(b => b.y + b.h),
          ...rightTrack.items.map(b => b.y + b.h)
        );

        // TWEAK THESE 4 VARIABLES TO FIX THE OVERALL CROP OUTLINE:
        // 1. Horizontal borders:
        const leftTrim = 2;       // If left edge of crop is off, adjust this

        // 2. Vertical borders (the upper and lower parts of the blue lines):
        // If the top of the blue line is too high/low, tweak topTrim.
        // Positive number moves the top downwards. Negative moves it upwards.
        const topTrim = 5;

        // If the bottom of the blue line is too high/low, tweak bottomPadding.
        // Positive number extends the line downwards. Negative shrinks it upwards.
        const bottomPadding = 7;

        const roiX = leftEdge + leftTrim;
        const roiY = topEdge + topTrim;
        const roiW = rightEdge - roiX;
        const roiH = (bottomEdge + bottomPadding) - roiY;

        if (roiW > 0 && roiH > 0) {
          console.log(`[OMR] 🧠 Initial Timing Track ROI: X=${roiX}, Y=${roiY}, W=${roiW}, H=${roiH}`);
          const roiRect = OpenCV.createObject(ObjectType.Rect, roiX, roiY, roiW, roiH);
          const croppedMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
          OpenCV.invoke('crop', binary, croppedMat, roiRect);

          // The 3rd image is now the pristine cropped answer area
          const colorCroppedMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
          OpenCV.invoke('cvtColor', croppedMat, colorCroppedMat, ColorConversionCodes.COLOR_GRAY2BGR);

          // The 4th image receives the scored reticles
          const scoredMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
          OpenCV.invoke('cvtColor', croppedMat, scoredMat, ColorConversionCodes.COLOR_GRAY2BGR);

          // The 5th image receives the sub-column (inner) splits
          const subColsMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
          OpenCV.invoke('cvtColor', croppedMat, subColsMat, ColorConversionCodes.COLOR_GRAY2BGR);

          // The 6th image receives the final row splits
          const rowsMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
          OpenCV.invoke('cvtColor', croppedMat, rowsMat, ColorConversionCodes.COLOR_GRAY2BGR);

          // The 7th image receives the final detected bubbles highlighted
          const finalScoredMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
          OpenCV.invoke('cvtColor', croppedMat, finalScoredMat, ColorConversionCodes.COLOR_GRAY2BGR);

          // Mathematical column splitting (Physical Layout Model)
          const numCols = 5;

          // TWEAK THESE 3 VARIABLES FOR MAIN COLUMNS:
          const leftMargin = 21;  // Pixels of white margin on the far left (before Col 1)
          const rightMargin = 22; // Pixels of white margin on the far right (after Col 5)
          const gapWidth = 15;    // Pixels of empty gap between Columns

          // Total Width = leftMargin + (5 * colWidth) + (4 * gapWidth) + rightMargin
          const colWidth = (roiW - leftMargin - rightMargin - ((numCols - 1) * gapWidth)) / numCols;

          // TWEAK THESE VARIABLES FOR INNER SUB-COLUMNS:
          // The Q column starts at the edge of the main column. You define its width.
          const qStartOffset = 0;  // Push the Question Number (YELLOW) block right by 2px. Smaller number moves it left.
          const qWidth = 25;       // Width of the Question Number block

          // Where do the A, B, C, D bubbles actually begin? 
          // (Pixels from the left edge of the main column). Smaller number moves the GREEN options left!
          const optionsStartOffset = 28;

          // Exclusively draw the bounds of the 5 Columns on the 4th Image
          // and the inner sub-columns on the 5th Image.
          for (let c = 0; c < numCols; c++) {
            const startX = Math.round(leftMargin + (c * (colWidth + gapWidth)));
            const endX = Math.round(startX + colWidth);

            const pt1 = OpenCV.createObject(ObjectType.Point, startX, 0);
            const pt2 = OpenCV.createObject(ObjectType.Point, endX, roiH);

            const colColor = OpenCV.createObject(ObjectType.Scalar, 255, 0, 0, 255); // Blue
            OpenCV.invoke('rectangle', scoredMat, pt1, pt2, colColor, 3, LineTypes.LINE_8);

            // -------------------------------------------------------------
            // DRAW SUB-COLUMNS ON THE 5TH IMAGE
            // -------------------------------------------------------------
            // 1. Draw Q Column
            const qStartX = startX + qStartOffset;
            const qEndX = qStartX + qWidth;
            const qPt1 = OpenCV.createObject(ObjectType.Point, Math.round(qStartX), 0);
            const qPt2 = OpenCV.createObject(ObjectType.Point, Math.round(qEndX), roiH);
            const qColor = OpenCV.createObject(ObjectType.Scalar, 0, 255, 255, 255); // Yellow for Q
            OpenCV.invoke('rectangle', subColsMat, qPt1, qPt2, qColor, 2, LineTypes.LINE_8);

            // 2. Draw Options (A, B, C, D)
            // They start at the explicit optionsStartOffset, and since they are equally spaced,
            // we perfectly divide the remaining mathematical width uniformly by 4!
            const optColor = OpenCV.createObject(ObjectType.Scalar, 0, 255, 0, 255); // Green for Options

            const optionSpace = colWidth - optionsStartOffset;
            const singleOptionWidth = optionSpace / 4;

            for (let opt = 0; opt < 4; opt++) {
              const oStartX = startX + optionsStartOffset + (opt * singleOptionWidth);
              const oEndX = oStartX + singleOptionWidth;

              const oPt1 = OpenCV.createObject(ObjectType.Point, Math.round(oStartX), 0);
              const oPt2 = OpenCV.createObject(ObjectType.Point, Math.round(oEndX), roiH);
              OpenCV.invoke('rectangle', subColsMat, oPt1, oPt2, optColor, 2, LineTypes.LINE_8);
            }
          }

          // -------------------------------------------------------------
          // DRAW ROWS ON THE 6TH IMAGE
          // -------------------------------------------------------------
          const numRows = 20;
          const rowHeight = roiH / numRows;
          const rowColor = OpenCV.createObject(ObjectType.Scalar, 255, 165, 0, 255); // Orange

          for (let r = 0; r <= numRows; r++) {
             const rowY = Math.round(r * rowHeight);
             const pt1 = OpenCV.createObject(ObjectType.Point, 0, rowY);
             const pt2 = OpenCV.createObject(ObjectType.Point, roiW, rowY);
             OpenCV.invoke('line', rowsMat, pt1, pt2, rowColor, 2, LineTypes.LINE_8);
          }

          // -------------------------------------------------------------
          // STEP 7: SCORE ALL BUBBLES
          // -------------------------------------------------------------
          const padding = 2; // Shave off border grid lines

          for (let c = 0; c < numCols; c++) {
            const startX = Math.round(leftMargin + (c * (colWidth + gapWidth)));
            const optionSpace = colWidth - optionsStartOffset;
            const singleOptionWidth = optionSpace / 4;

            for (let r = 0; r < numRows; r++) {
               const rowY = Math.round(r * rowHeight);

               let bestOpt = -1;
               let bestScore = -1;
               let scores = [];

               for (let opt = 0; opt < 4; opt++) {
                  const bubbleX = startX + optionsStartOffset + (opt * singleOptionWidth);
                  
                  const safeX = Math.round(bubbleX + padding);
                  const safeY = Math.round(rowY + padding);
                  const safeW = Math.round(singleOptionWidth - (2 * padding));
                  const safeH = Math.round(rowHeight - (2 * padding));

                  const cellRect = OpenCV.createObject(ObjectType.Rect, safeX, safeY, safeW, safeH);
                  const cellMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
                  OpenCV.invoke('crop', croppedMat, cellMat, cellRect);
                  
                  // Count white pixels (pencil marks)
                  const countObj = OpenCV.invoke('countNonZero', cellMat) as { value: number };
                  const count = countObj.value;
                  scores.push(count);

                  if (count > bestScore) {
                     bestScore = count;
                     bestOpt = opt;
                  }
               }

               console.log(`[OMR] 🧠 Col ${c+1} Row ${r+1} | Densities: [${scores.join(', ')}] -> Selected: ${['A','B','C','D'][bestOpt] || 'None'}`);

               // Highlight the selected answer on finalScoredMat if it passes a minimum density test
               // (Prevents scoring completely empty rows)
               const minDensityThreshold = 20; 
               if (bestScore > minDensityThreshold && bestOpt !== -1) {
                  const winningX = Math.round(startX + optionsStartOffset + (bestOpt * singleOptionWidth));
                  const pt1 = OpenCV.createObject(ObjectType.Point, winningX, rowY);
                  const pt2 = OpenCV.createObject(ObjectType.Point, winningX + Math.round(singleOptionWidth), rowY + Math.round(rowHeight));
                  
                  const markColor = OpenCV.createObject(ObjectType.Scalar, 0, 0, 255, 255); // Red Frame
                  OpenCV.invoke('rectangle', finalScoredMat, pt1, pt2, markColor, 3, LineTypes.LINE_8);
               }
            }
          }

          // Save cropped grid image
          const croppedFileName = `${RNFS.CachesDirectoryPath}/omr_cropped_${Date.now()}.jpg`;
          OpenCV.saveMatToFile(colorCroppedMat, croppedFileName, 'jpeg', 0.8);
          croppedPath = `file://${croppedFileName}`;

          // Save scored image
          const scoredFileName = `${RNFS.CachesDirectoryPath}/omr_scored_${Date.now()}.jpg`;
          OpenCV.saveMatToFile(scoredMat, scoredFileName, 'jpeg', 0.8);
          scoredPath = `file://${scoredFileName}`;

          // Save sub-columns image
          const subColsFileName = `${RNFS.CachesDirectoryPath}/omr_subcols_${Date.now()}.jpg`;
          OpenCV.saveMatToFile(subColsMat, subColsFileName, 'jpeg', 0.8);
          subColumnsPath = `file://${subColsFileName}`;

          // Save rows image
          const rowsFileName = `${RNFS.CachesDirectoryPath}/omr_rows_${Date.now()}.jpg`;
          OpenCV.saveMatToFile(rowsMat, rowsFileName, 'jpeg', 0.8);
          rowsPath = `file://${rowsFileName}`;

          // Save final scored image
          const finalFileName = `${RNFS.CachesDirectoryPath}/omr_final_${Date.now()}.jpg`;
          OpenCV.saveMatToFile(finalScoredMat, finalFileName, 'jpeg', 0.8);
          finalScoredPath = `file://${finalFileName}`;
        } else {
          console.log(`[OMR] 🚨 Invalid crop dimensions: W=${roiW}, H=${roiH}`);
        }
      }

      // 9. Return images
      const binaryPath = `${RNFS.CachesDirectoryPath}/omr_binary_${Date.now()}.jpg`;
      const outlinedPath = `${RNFS.CachesDirectoryPath}/omr_outlined_${Date.now()}.jpg`;

      OpenCV.saveMatToFile(binary, binaryPath, 'jpeg', 0.8);
      OpenCV.saveMatToFile(drawImg, outlinedPath, 'jpeg', 0.8);

      OpenCV.clearBuffers();

      return {
        binary: `file://${binaryPath}`,
        outlined: `file://${outlinedPath}`,
        cropped: croppedPath,
        scored: scoredPath,
        subColumns: subColumnsPath,
        rows: rowsPath,
        finalScored: finalScoredPath
      };
    } catch (e) {
      console.log('[OMR] 🧠 Something went wrong:', e);
      OpenCV.clearBuffers();
      throw e;
    }
  }
}
