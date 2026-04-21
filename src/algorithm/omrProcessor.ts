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
  MorphTypes,
  MorphShapes,
  NormTypes,
  InterpolationFlags,
} from 'react-native-fast-opencv';

export class OMRProcessor {
  static async processImage(imagePath: string): Promise<{ binary: string, outlined: string, cropped: string | null, majorBoxes: string | null, scored: string | null, subColumns: string | null, rows: string | null, finalScored: string | null }> {
    try {
      const b64 = await RNFS.readFile(imagePath, 'base64');
      const imgMat = OpenCV.base64ToMat(b64);

      const rawInfo = OpenCV.toJSValue(imgMat) as any;
      const rawCols = rawInfo.cols || 2480;
      const rawRows = rawInfo.rows || 3508;

      // 1-0. Force Standard Processing Resolution (1200px width)
      const targetWidth = 1200;
      const targetHeight = Math.round((targetWidth / rawCols) * rawRows);
      
      const resizedMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
      OpenCV.invoke('resize', imgMat, resizedMat, OpenCV.createObject(ObjectType.Size, targetWidth, targetHeight), 0, 0, InterpolationFlags.INTER_LINEAR);

      let gray = resizedMat;
      const info = OpenCV.toJSValue(resizedMat) as Record<string, any>;
      const channels = (info.type >> 3) + 1;
      const mCols = info.cols || targetWidth;
      const mRows = info.rows || targetHeight;

      if (channels > 1) {
        gray = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
        if (channels === 3) {
          OpenCV.invoke('cvtColor', resizedMat, gray, ColorConversionCodes.COLOR_BGR2GRAY);
        } else {
          OpenCV.invoke('cvtColor', resizedMat, gray, ColorConversionCodes.COLOR_RGBA2GRAY);
        }
      }

      // 1-A. Normalization & Blur
      // Removed heavy Gaussian Blur as it distorts thin lines and bubbles.
      // Light thresholding preserves crisp column borders while size filters remove the sand!

      // 1-B. Crisp Adaptive Threshold (Inverse)
      const thresh = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
      OpenCV.invoke('adaptiveThreshold',
        gray,
        thresh,
        255,
        AdaptiveThresholdTypes.ADAPTIVE_THRESH_GAUSSIAN_C,
        ThresholdTypes.THRESH_BINARY_INV,
        35, // Larger block size captures wider light context
        13  // Stronger bias completely stops thick lines and crushes shadow noise
      );

      // 1-C. Skip Morphology
      // No morphology here! The 'thick bubbles' were caused by MORPH_CLOSE fusing the inner gaps. 
      // Sticking strictly to crisp adaptive thresholding preserves thin bubble borders!
      const binary = thresh; // Pass directly to next step

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

      // 4. Filter into rectangle candidates (moderate filter for 1200px width)
      // Timing tracks on 1200px are ~25px by ~10px. This allows them through but dumps sand.
      const rectCandidates = boundingBoxes.filter(b => b.w >= 8 && b.h >= 5 && b.w < 150 && b.h < 150); 
      console.log(`[OMR] 🧠 ${rectCandidates.length} tracking blocks remaining after destroying noise sand.`);

      // 5. Skip drawing all rectCandidates to keep Step 2 exclusively for the colored Left/Right timing      // 6. Group by TIGHT X position to prevent horizontal overlap with bubbles!
      const xTolerance = 12; // Extremely tight: Impossible for bubbles to bridge into the track group!
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

      // 7. Count rectangles per group & sort dynamically Left to Right
      const validTracks = groups.filter(g => g.items.length >= 6); // Accept smaller clusters in case of skew-splintering
      validTracks.sort((a, b) => a.centerX - b.centerX);

      // 8. Find the outermost Left and Right clusters
      const primaryLeft = validTracks[0];
      const primaryRight = validTracks[validTracks.length - 1];

      // To handle diagonal page skews (which split the track into adjacent splinters under a tight xTolerance),
      // we aggregate any splinters that are intimately close to the primary anchors!
      const leftTrackItems = primaryLeft ? validTracks.filter(g => Math.abs(g.centerX - primaryLeft.centerX) <= 35).flatMap(g => g.items) : [];
      const rightTrackItems = primaryRight ? validTracks.filter(g => Math.abs(g.centerX - primaryRight.centerX) <= 35).flatMap(g => g.items) : [];

      if (!primaryLeft || !primaryRight || leftTrackItems.length === 0 || rightTrackItems.length === 0) {
        console.log('[OMR] 🧠 tracks not detected (missing left or right tracking columns)');
      }

      // Highlight the aggregated tracking marks safely
      for (const box of leftTrackItems) {
         const pt1 = OpenCV.createObject(ObjectType.Point, box.x, box.y);
         const pt2 = OpenCV.createObject(ObjectType.Point, box.x + box.w, box.y + box.h);
         const color = OpenCV.createObject(ObjectType.Scalar, 0, 0, 255, 255); // Red
         OpenCV.invoke('rectangle', drawImg, pt1, pt2, color, -1, LineTypes.LINE_8);
      }
      for (const box of rightTrackItems) {
         const pt1 = OpenCV.createObject(ObjectType.Point, box.x, box.y);
         const pt2 = OpenCV.createObject(ObjectType.Point, box.x + box.w, box.y + box.h);
         const color = OpenCV.createObject(ObjectType.Scalar, 255, 0, 0, 255); // Blue
         OpenCV.invoke('rectangle', drawImg, pt1, pt2, color, -1, LineTypes.LINE_8);
      }

      // 9. Crop Area using inner boundaries
      let roiX = 0, roiY = 0, roiW = mCols, roiH = mRows;
      let isCropped = false;

      if (leftTrackItems.length > 0 && rightTrackItems.length > 0) {
        // Inner edge of left track = absolute max(box.x + box.w)
        const leftEdge = Math.max(...leftTrackItems.map(b => b.x + b.w));

        // Inner edge of right track = absolute min(box.x)
        const rightEdge = Math.min(...rightTrackItems.map(b => b.x)); }
      }

      let croppedPath: string | null = null;
      let majorBoxesPath: string | null = null;
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

        let roiX = leftEdge + leftTrim;
        let roiY = topEdge + topTrim;
        let roiW = rightEdge - roiX;
        let roiH = (bottomEdge + bottomPadding) - roiY;

        // 8-B. CLAMP ROI TO IMAGE BOUNDARIES (Prevents OpenCV Assertion Crashes)
        roiX = Math.max(0, roiX);
        roiY = Math.max(0, roiY);
        if (roiX + roiW > mCols) roiW = mCols - roiX;
        if (roiY + roiH > mRows) roiH = mRows - roiY;

        if (roiW > 0 && roiH > 0) {
          console.log(`[OMR] 🧠 Initial Timing Track ROI: X=${roiX}, Y=${roiY}, W=${roiW}, H=${roiH}`);
          const roiRect = OpenCV.createObject(ObjectType.Rect, roiX, roiY, roiW, roiH);
          const croppedMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
          OpenCV.invoke('crop', binary, croppedMat, roiRect);

          // Fetch cropped info securely to prevent downstream cell crashes
          const cInfo = OpenCV.toJSValue(croppedMat) as Record<string, any>;
          const cCols = cInfo.cols;
          const cRows = cInfo.rows;

          // The 3rd image is now the pristine cropped answer area
          const colorCroppedMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
          OpenCV.invoke('cvtColor', croppedMat, colorCroppedMat, ColorConversionCodes.COLOR_GRAY2BGR);

          // The 4th image is dedicated strictly to Semantic Region (Major Box) Detection
          const majorMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
          OpenCV.invoke('cvtColor', croppedMat, majorMat, ColorConversionCodes.COLOR_GRAY2BGR);

          // The 5th image receives the scored reticles
          const scoredMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
          OpenCV.invoke('cvtColor', croppedMat, scoredMat, ColorConversionCodes.COLOR_GRAY2BGR);

          // The 6th image receives the sub-column (inner) splits
          const subColsMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
          OpenCV.invoke('cvtColor', croppedMat, subColsMat, ColorConversionCodes.COLOR_GRAY2BGR);

          // The 7th image receives the final row splits
          const rowsMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
          OpenCV.invoke('cvtColor', croppedMat, rowsMat, ColorConversionCodes.COLOR_GRAY2BGR);

          // The 8th image receives the final detected bubbles highlighted
          const finalScoredMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
          OpenCV.invoke('cvtColor', croppedMat, finalScoredMat, ColorConversionCodes.COLOR_GRAY2BGR);

          // ------------------------------------------------------------------------
          // STRATEGY: DYNAMIC MACRO CLUSTERING (Melt & Scan Concept)
          // Since the sheet columns aren't enclosed by printed ink boxes, we scan all elements (bubbles, text)
          // and physically cluster them into Macro Columns based on horizontal alignment!
          // ------------------------------------------------------------------------
          const internalContoursMat = OpenCV.createObject(ObjectType.PointVectorOfVectors);
          OpenCV.invoke('findContours', croppedMat, internalContoursMat, RetrievalModes.RETR_EXTERNAL, ContourApproximationModes.CHAIN_APPROX_SIMPLE);
          
          const innerJsValue = OpenCV.toJSValue(internalContoursMat) as any;
          const innerContoursValues: {x: number, y: number}[][] = innerJsValue && innerJsValue.array ? innerJsValue.array : [];

          const safeInternalBoxes = innerContoursValues.map((pts) => {
             let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
             if (!pts) return null;
             for (const p of pts) {
               if (p.x < minX) minX = p.x;
               if (p.y < minY) minY = p.y;
               if (p.x > maxX) maxX = p.x;
               if (p.y > maxY) maxY = p.y;
             }
             if (minX === Infinity || maxX === -Infinity) return null;
             return {x: minX, y: minY, w: maxX - minX, h: maxY - minY};
          }).filter(Boolean) as {x: number, y: number, w: number, h: number}[];

          // 1. Filter out raw dust AND page-wide universal bridges (like long title underlines)
          const validElements = safeInternalBoxes.filter(b => b.w > 8 && b.h > 8 && b.w < (cCols * 0.6) && b.h < (cRows * 0.8));

          // 2. 2D Proximity Semantic Sectioning
          // If elements are physically close vertically AND horizontally, they naturally belong to the same block.
          let columnBoxes: {x: number, y: number, w: number, h: number}[] = [];
          
          for (const box of validElements) {
             let foundGroup = false;
             for (let mb of columnBoxes) {
                const boxRight = box.x + box.w;
                const boxBottom = box.y + box.h;
                const mbRight = mb.x + mb.w;
                const mbBottom = mb.y + mb.h;
                
                // hClose = 40 pixels (bridges A, B, C, D but stops at Column gaps)
                // vClose = 60 pixels (bridges rows going downwards)
                const hClose = (box.x <= mbRight + 40) && (boxRight >= mb.x - 40);
                const vClose = (box.y <= mbBottom + 60) && (boxBottom >= mb.y - 60);

                if (hClose && vClose) {
                   mb.x = Math.min(mb.x, box.x);
                   mb.y = Math.min(mb.y, box.y);
                   mb.w = Math.max(mbRight, boxRight) - mb.x;
                   mb.h = Math.max(mbBottom, boxBottom) - mb.y;
                   foundGroup = true;
                   break;
                }
             }
             if (!foundGroup) {
                columnBoxes.push({ ...box });
             }
          }

          // 3. Resolve expansion overlaps
          let merging = true;
          while (merging) {
             merging = false;
             for (let i = 0; i < columnBoxes.length; i++) {
                for (let j = i + 1; j < columnBoxes.length; j++) {
                   const a = columnBoxes[i];
                   const b = columnBoxes[j];
                   const aR = a.x + a.w;
                   const aB = a.y + a.h;
                   const bR = b.x + b.w;
                   const bB = b.y + b.h;

                   const hClose = (a.x <= bR + 40) && (aR >= b.x - 40);
                   const vClose = (a.y <= bB + 60) && (aB >= b.y - 60);

                   if (hClose && vClose) {
                      a.x = Math.min(a.x, b.x);
                      a.y = Math.min(a.y, b.y);
                      a.w = Math.max(aR, bR) - a.x;
                      a.h = Math.max(aB, bB) - a.y;
                      columnBoxes.splice(j, 1);
                      merging = true;
                      break;
                   }
                }
                if (merging) break;
             }
          }
          
          // Sort by Top to Bottom, then Left to Right
          columnBoxes.sort((a,b) => (a.y * 1000 + a.x) - (b.y * 1000 + b.x));

          // Drop noise clusters
          columnBoxes = columnBoxes.filter(b => b.h > 40 && b.w > 40);

          console.log(`[OMR] 🧠 Dynamically Clustered ${validElements.length} internal elements into ${columnBoxes.length} Major Semantic Boxes!`);

          // Draw Semantic Region Boundaries onto the majorMat
          for (const box of columnBoxes) {
              const pt1 = OpenCV.createObject(ObjectType.Point, box.x, box.y);
              const pt2 = OpenCV.createObject(ObjectType.Point, box.x + box.w, box.y + box.h);
              const color = OpenCV.createObject(ObjectType.Scalar, 0, 255, 0, 255); // Green mapping
              OpenCV.invoke('rectangle', majorMat, pt1, pt2, color, 4, LineTypes.LINE_8);
          }

          const numCols = columnBoxes.length > 0 ? columnBoxes.length : 5; 

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
            let startX, colWidth, colStartY, colHeight;

            if (columnBoxes.length === numCols) {
                // Dynamically use the found major box!
                startX = columnBoxes[c].x;
                colWidth = columnBoxes[c].w;
                colStartY = columnBoxes[c].y;
                colHeight = columnBoxes[c].h;
            } else {
                // Fallback geometry if dynamic boxes were not found appropriately
                const leftMargin = 21; 
                const rightMargin = 22;
                const gapWidth = 15;
                const mathColWidth = (cCols - leftMargin - rightMargin - ((5 - 1) * gapWidth)) / 5;
                startX = Math.round(leftMargin + (c * (mathColWidth + gapWidth)));
                colWidth = mathColWidth;
                colStartY = 0;
                colHeight = cRows;
            }

            const endX = Math.round(startX + colWidth);

            const pt1 = OpenCV.createObject(ObjectType.Point, startX, colStartY);
            const pt2 = OpenCV.createObject(ObjectType.Point, endX, colStartY + colHeight);

            const colColor = OpenCV.createObject(ObjectType.Scalar, 255, 0, 0, 255); // Blue
            OpenCV.invoke('rectangle', scoredMat, pt1, pt2, colColor, 3, LineTypes.LINE_8);

            // -------------------------------------------------------------
            // DRAW SUB-COLUMNS ON THE 5TH IMAGE
            // -------------------------------------------------------------
            // 1. Draw Q Column
            const qStartX = startX + qStartOffset;
            const qEndX = qStartX + qWidth;
            const qPt1 = OpenCV.createObject(ObjectType.Point, Math.round(qStartX), colStartY);
            const qPt2 = OpenCV.createObject(ObjectType.Point, Math.round(qEndX), colStartY + colHeight);
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

              const oPt1 = OpenCV.createObject(ObjectType.Point, Math.round(oStartX), colStartY);
              const oPt2 = OpenCV.createObject(ObjectType.Point, Math.round(oEndX), colStartY + colHeight);
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
            let startX, colWidth, colStartY, colHeight;
            if (columnBoxes.length === numCols) {
                startX = columnBoxes[c].x;
                colWidth = columnBoxes[c].w;
                colStartY = columnBoxes[c].y;
                colHeight = columnBoxes[c].h;
            } else {
                const leftMargin = 21; 
                const rightMargin = 22;
                const gapWidth = 15;
                const mathColWidth = (cCols - leftMargin - rightMargin - ((5 - 1) * gapWidth)) / 5;
                startX = Math.round(leftMargin + (c * (mathColWidth + gapWidth)));
                colWidth = mathColWidth;
                colStartY = 0;
                colHeight = cRows;
            }

            const optionSpace = colWidth - optionsStartOffset;
            const singleOptionWidth = optionSpace / 4;

            // Update rowHeight to use the dynamically found column height!
            const rowHeight = colHeight / numRows;

            for (let r = 0; r < numRows; r++) {
               const rowY = Math.round(colStartY + (r * rowHeight));

               let bestOpt = -1;
               let bestScore = -1;
               let scores = [];

               for (let opt = 0; opt < 4; opt++) {
                  const bubbleX = startX + optionsStartOffset + (opt * singleOptionWidth);
                  
                  let safeX = Math.round(bubbleX + padding);
                  let safeY = Math.round(rowY + padding);
                  let safeW = Math.round(singleOptionWidth - (2 * padding));
                  let safeH = Math.round(rowHeight - (2 * padding));

                  // SECURE CLAMPING: Prevents cell rounding errors from violating matrix bounds
                  safeX = Math.max(0, safeX);
                  safeY = Math.max(0, safeY);
                  if (safeX + safeW > cCols) safeW = cCols - safeX;
                  if (safeY + safeH > cRows) safeH = cRows - safeY;

                  // Safety skip if dimensions collapsed entirely
                  if (safeW <= 0 || safeH <= 0) continue;

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

          // Save major boxes image
          const majorBoxesFileName = `${RNFS.CachesDirectoryPath}/omr_major_${Date.now()}.jpg`;
          OpenCV.saveMatToFile(majorMat, majorBoxesFileName, 'jpeg', 0.8);
          majorBoxesPath = `file://${majorBoxesFileName}`;

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
        majorBoxes: majorBoxesPath,
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
