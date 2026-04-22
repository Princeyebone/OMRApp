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

      const binary = thresh; // Pass directly to next step

      // We need a color version to draw debug markers
      const drawImg = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
      OpenCV.invoke('cvtColor', binary, drawImg, ColorConversionCodes.COLOR_GRAY2BGR);

      // 2. Find contours
      const contours = OpenCV.createObject(ObjectType.PointVectorOfVectors);
      OpenCV.invoke('findContours', binary, contours, RetrievalModes.RETR_EXTERNAL, ContourApproximationModes.CHAIN_APPROX_SIMPLE);

      // 3. Process contours
      const parsed = OpenCV.toJSValue(contours) as any;
      const jsContours: { x: number, y: number }[][] = parsed && parsed.array ? parsed.array : [];
      console.log(`[OMR] Detected ${jsContours.length} raw contours.`);

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

      // 4. Filter for timing track candidates
      const rectCandidates = boundingBoxes.filter(b => b.w >= 8 && b.h >= 5 && b.w < 150 && b.h < 150); 

      // 5. Group by TIGHT X position to prevent horizontal overlap with bubbles
      const xTolerance = 12;
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

      // Identify outermost tracks
      const validGroups = groups.filter(g => g.items.length >= 6); 
      validGroups.sort((a, b) => a.centerX - b.centerX);

      const primaryLeft = validGroups[0];
      const primaryRight = validGroups[validGroups.length - 1];

      const leftTrackItems = primaryLeft ? validGroups.filter(g => Math.abs(g.centerX - primaryLeft.centerX) <= 35).flatMap(g => g.items) : [];
      const rightTrackItems = primaryRight ? validGroups.filter(g => Math.abs(g.centerX - primaryRight.centerX) <= 35).flatMap(g => g.items) : [];

      // Draw tracked markers on Step 2
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

      let croppedPath: string | null = null;
      let majorBoxesPath: string | null = null;
      let scoredPath: string | null = null;
      let subColumnsPath: string | null = null;
      let rowsPath: string | null = null;
      let finalScoredPath: string | null = null;

      if (leftTrackItems.length > 0 && rightTrackItems.length > 0) {
        const leftEdge = Math.max(...leftTrackItems.map(b => b.x + b.w));
        const rightEdge = Math.min(...rightTrackItems.map(b => b.x));
        const topEdge = Math.min(...leftTrackItems.map(b => b.y), ...rightTrackItems.map(b => b.y));
        const bottomEdge = Math.max(...leftTrackItems.map(b => b.y + b.h), ...rightTrackItems.map(b => b.y + b.h));

        const leftTrim = 2;
        const topTrim = 5;
        const bottomPadding = 7;

        let roiX = leftEdge + leftTrim;
        let roiY = topEdge + topTrim;
        let roiW = rightEdge - roiX;
        let roiH = (bottomEdge + bottomPadding) - roiY;

        // Clamp
        roiX = Math.max(0, roiX);
        roiY = Math.max(0, roiY);
        if (roiX + roiW > mCols) roiW = mCols - roiX;
        if (roiY + roiH > mRows) roiH = mRows - roiY;

        if (roiW > 0 && roiH > 0) {
          const roiRect = OpenCV.createObject(ObjectType.Rect, roiX, roiY, roiW, roiH);
          const croppedMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
          OpenCV.invoke('crop', binary, croppedMat, roiRect);

          const cInfo = OpenCV.toJSValue(croppedMat) as Record<string, any>;
          const cCols = cInfo.cols;
          const cRows = cInfo.rows;

          const colorCroppedMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
          OpenCV.invoke('cvtColor', croppedMat, colorCroppedMat, ColorConversionCodes.COLOR_GRAY2BGR);

          const majorMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
          OpenCV.invoke('cvtColor', croppedMat, majorMat, ColorConversionCodes.COLOR_GRAY2BGR);

          const scoredMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
          OpenCV.invoke('cvtColor', croppedMat, scoredMat, ColorConversionCodes.COLOR_GRAY2BGR);

          const subColsMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
          OpenCV.invoke('cvtColor', croppedMat, subColsMat, ColorConversionCodes.COLOR_GRAY2BGR);

          const rowsMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
          OpenCV.invoke('cvtColor', croppedMat, rowsMat, ColorConversionCodes.COLOR_GRAY2BGR);

          const finalScoredMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
          OpenCV.invoke('cvtColor', croppedMat, finalScoredMat, ColorConversionCodes.COLOR_GRAY2BGR);

          // --- Step 4. RAW CONTOUR DIAGNOSTIC VIEW ---
          // Goal: Find EVERY contour on the cropped sheet and draw them all.
          // No filtering, no clustering, no routing. This is a pure ground-truth
          // view of what OpenCV can physically detect on the paper.

          // 4A: Find ALL contours — no size filters applied yet.
          const allContoursMat = OpenCV.createObject(ObjectType.PointVectorOfVectors);
          OpenCV.invoke('findContours', croppedMat, allContoursMat, RetrievalModes.RETR_EXTERNAL, ContourApproximationModes.CHAIN_APPROX_SIMPLE);
          const rawAllJs = OpenCV.toJSValue(allContoursMat) as any;
          const allContourPts: {x: number, y: number}[][] = rawAllJs && rawAllJs.array ? rawAllJs.array : [];

          // 4B: Convert every contour to its axis-aligned bounding box.
          const allBoundingBoxes = allContourPts.map((pts) => {
            if (!pts || pts.length === 0) return null;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const p of pts) {
              if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
              if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
            }
            return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
          }).filter(Boolean) as { x: number, y: number, w: number, h: number }[];

          console.log(`[OMR] 🔍 Step 4 RAW: Detected ${allBoundingBoxes.length} total contours on cropped sheet.`);

          // --- SIZE DISTRIBUTION DEBUG ---
          // Helps determine the right W/H thresholds for filtering.
          // Read these buckets to decide what counts as noise vs bubble vs frame.
          if (allBoundingBoxes.length > 0) {
            const areas = allBoundingBoxes.map(b => ({ w: b.w, h: b.h, area: b.w * b.h }));

            const minW = Math.min(...areas.map(a => a.w));
            const maxW = Math.max(...areas.map(a => a.w));
            const minH = Math.min(...areas.map(a => a.h));
            const maxH = Math.max(...areas.map(a => a.h));
            console.log(`[OMR] 📐 Size Range: W=${minW}–${maxW}px  H=${minH}–${maxH}px`);

            // Width histogram buckets
            const wBuckets: Record<string, number> = {
              'W  0–4  (dust)':   0,
              'W  5–9  (tiny)':   0,
              'W 10–19 (small)':  0,
              'W 20–39 (medium)': 0,
              'W 40–79 (large)':  0,
              'W 80–199 (huge)':  0,
              'W 200+  (giant)':  0,
            };
            // Height histogram buckets
            const hBuckets: Record<string, number> = {
              'H  0–4  (dust)':   0,
              'H  5–9  (tiny)':   0,
              'H 10–19 (small)':  0,
              'H 20–39 (medium)': 0,
              'H 40–79 (large)':  0,
              'H 80–199 (huge)':  0,
              'H 200+  (giant)':  0,
            };

            for (const { w, h } of areas) {
              if      (w <= 4)   wBuckets['W  0–4  (dust)']++;
              else if (w <= 9)   wBuckets['W  5–9  (tiny)']++;
              else if (w <= 19)  wBuckets['W 10–19 (small)']++;
              else if (w <= 39)  wBuckets['W 20–39 (medium)']++;
              else if (w <= 79)  wBuckets['W 40–79 (large)']++;
              else if (w <= 199) wBuckets['W 80–199 (huge)']++;
              else               wBuckets['W 200+  (giant)']++;

              if      (h <= 4)   hBuckets['H  0–4  (dust)']++;
              else if (h <= 9)   hBuckets['H  5–9  (tiny)']++;
              else if (h <= 19)  hBuckets['H 10–19 (small)']++;
              else if (h <= 39)  hBuckets['H 20–39 (medium)']++;
              else if (h <= 79)  hBuckets['H 40–79 (large)']++;
              else if (h <= 199) hBuckets['H 80–199 (huge)']++;
              else               hBuckets['H 200+  (giant)']++;
            }

            console.log('[OMR] 📊 Width Distribution:');
            for (const [label, count] of Object.entries(wBuckets)) {
              if (count > 0) console.log(`[OMR]   ${label}: ${count}`);
            }
            console.log('[OMR] 📊 Height Distribution:');
            for (const [label, count] of Object.entries(hBuckets)) {
              if (count > 0) console.log(`[OMR]   ${label}: ${count}`);
            }

            // Top-10 largest contours by area (helps spot unwanted giant frames)
            const top10 = [...areas].sort((a, b) => b.area - a.area).slice(0, 10);
            console.log('[OMR] 🏆 Top-10 Largest Contours (W×H):');
            top10.forEach((a, i) => console.log(`[OMR]   #${i + 1}: ${a.w}×${a.h} = ${a.area}px²`));
          }
          // --- END SIZE DISTRIBUTION DEBUG ---

          // 4C: Draw ALL bounding boxes in dim green (thin) — full raw view.
          for (const box of allBoundingBoxes) {
            if (box.w < 3 || box.h < 3) continue;
            const pt1 = OpenCV.createObject(ObjectType.Point, box.x, box.y);
            const pt2 = OpenCV.createObject(ObjectType.Point, box.x + box.w, box.y + box.h);
            OpenCV.invoke('rectangle', majorMat, pt1, pt2, OpenCV.createObject(ObjectType.Scalar, 0, 180, 0, 255), 1, LineTypes.LINE_8);
          }

          // 4D: Highlight the TOP-8 TALLEST contours in RED (thick border).
          // These are the "H 200+ giant" candidates — the structural sections of the sheet.
          const top8ByHeight = [...allBoundingBoxes]
            .sort((a, b) => b.h - a.h)
            .slice(0, 8);

          console.log('[OMR] 🎯 Top-8 by Height (structural candidates):');
          top8ByHeight.forEach((box, i) => {
            // Auto-guess identity from shape ratio and size
            let identity = 'unknown';
            const aspectRatio = box.h / (box.w || 1); // h:w ratio
            if (box.w > cCols * 0.7) {
              identity = '🚫 PAGE FRAME (full-width — exclude)';
            } else if (aspectRatio >= 3 && box.h > cRows * 0.5) {
              identity = '✅ ANSWER COLUMN (tall & narrow)';
            } else if (aspectRatio < 2 && box.w > 100) {
              identity = '📋 ID / HEADER BLOCK (wide & shorter)';
            } else if (box.h > 200) {
              identity = '❓ LARGE UNKNOWN REGION';
            }

            console.log(`[OMR]   Rank ${i + 1}: W=${box.w} H=${box.h} @ (${box.x},${box.y}) → ${identity}`);

            // Draw in bright red with thick border
            const rPt1 = OpenCV.createObject(ObjectType.Point, box.x, box.y);
            const rPt2 = OpenCV.createObject(ObjectType.Point, box.x + box.w, box.y + box.h);
            OpenCV.invoke('rectangle', majorMat, rPt1, rPt2, OpenCV.createObject(ObjectType.Scalar, 0, 0, 255, 255), 4, LineTypes.LINE_8);
          });

          // ---------------------------------------------------------------
          // The clustering/routing logic below is preserved so that
          // Steps 5-8 (scoring) continue to operate. It does NOT affect
          // what is drawn on majorMat (the Step 4 debug image).
          // ---------------------------------------------------------------

          // Bubble-sized candidates (for scoring pipeline only)
          const bubbleCandidates = allBoundingBoxes.filter(b => b.w >= 8 && b.w <= 100 && b.h >= 8 && b.h <= 50);

          // Proximity-Based Clustering
          const bubbleClusters: (typeof bubbleCandidates)[] = [];
          for (const b of bubbleCandidates) {
            let added = false;
            for (const cluster of bubbleClusters) {
              for (const member of cluster) {
                const xDist = Math.max(0, Math.max(b.x - (member.x + member.w), member.x - (b.x + b.w)));
                const yDist = Math.max(0, Math.max(b.y - (member.y + member.h), member.y - (b.y + b.h)));
                if (xDist < 35 && yDist < 35) { cluster.push(b); added = true; break; }
              }
              if (added) break;
            }
            if (!added) bubbleClusters.push([b]);
          }

          // Agglomerative Merge
          let ClustersMerged = true;
          while (ClustersMerged) {
            ClustersMerged = false;
            for (let i = 0; i < bubbleClusters.length; i++) {
              for (let j = i + 1; j < bubbleClusters.length; j++) {
                let close = false;
                outer: for (const b1 of bubbleClusters[i]) {
                  for (const b2 of bubbleClusters[j]) {
                    const xD = Math.max(0, Math.max(b1.x - (b2.x + b2.w), b2.x - (b1.x + b1.w)));
                    const yD = Math.max(0, Math.max(b1.y - (b2.y + b2.h), b2.y - (b1.y + b1.h)));
                    if (xD < 35 && yD < 35) { close = true; break outer; }
                  }
                }
                if (close) {
                  bubbleClusters[i] = bubbleClusters[i].concat(bubbleClusters[j]);
                  bubbleClusters.splice(j, 1);
                  ClustersMerged = true;
                  break;
                }
              }
              if (ClustersMerged) break;
            }
          }

          // Build final column boxes
          let columnBoxes: { x: number, y: number, w: number, h: number, bubbleCount: number }[] = [];
          for (const cluster of bubbleClusters) {
            if (cluster.length >= 8) {
              let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
              for (const b of cluster) {
                if (b.x < minX) minX = b.x; if (b.y < minY) minY = b.y;
                if (b.x + b.w > maxX) maxX = b.x + b.w; if (b.y + b.h > maxY) maxY = b.y + b.h;
              }
              const pad = 4;
              columnBoxes.push({
                x: Math.max(0, minX - pad), y: Math.max(0, minY - pad),
                w: Math.min(cCols - minX, (maxX - minX) + pad * 2),
                h: Math.min(cRows - minY, (maxY - minY) + pad * 2),
                bubbleCount: cluster.length,
              });
            }
          }
          columnBoxes.sort((a, b) => Math.abs(a.x - b.x) < 50 ? a.y - b.y : a.x - b.x);

          console.log(`[OMR] 🧠 Cluster Breakdown (for scoring):`);
          columnBoxes.forEach((b, i) => console.log(`[OMR]   Block ${i + 1}: X=${b.x}, Y=${b.y}, W=${b.w}, H=${b.h}, Bubbles=${b.bubbleCount}`));

          // Semantic Routing (answer columns vs ID blocks) — feeds Steps 5-8 only
          const answerColumns = columnBoxes.filter(b => b.h > b.w * 2 && b.h > cRows * 0.4);
          const idBlocks = columnBoxes.filter(b => b.h <= b.w * 2 || b.h <= cRows * 0.4);
          console.log(`[OMR] Routing: ${answerColumns.length} Answer Columns, ${idBlocks.length} ID Blocks.`);

          const numCols = answerColumns.length > 0 ? answerColumns.length : 5;
          const optionsStartOffset = 28;
          const qWidth = 25;

          // Main Column Splits (Step 5/6)
          for (let c = 0; c < numCols; c++) {
            let startX, colWidth, colStartY, colHeight;
            if (answerColumns.length === numCols) {
              startX = answerColumns[c].x;
              colWidth = answerColumns[c].w;
              colStartY = answerColumns[c].y;
              colHeight = answerColumns[c].h;
            } else {
              const mathColWidth = (cCols - 58) / 5;
              startX = 21 + (c * (mathColWidth + 15));
              colWidth = mathColWidth;
              colStartY = 0;
              colHeight = cRows;
            }
            const pt1 = OpenCV.createObject(ObjectType.Point, startX, colStartY);
            const pt2 = OpenCV.createObject(ObjectType.Point, startX + colWidth, colStartY + colHeight);
            OpenCV.invoke('rectangle', scoredMat, pt1, pt2, OpenCV.createObject(ObjectType.Scalar, 255, 0, 0, 255), 3, LineTypes.LINE_8);

            // Sub-columns
            const qPt1 = OpenCV.createObject(ObjectType.Point, startX, colStartY);
            const qPt2 = OpenCV.createObject(ObjectType.Point, startX + qWidth, colStartY + colHeight);
            OpenCV.invoke('rectangle', subColsMat, qPt1, qPt2, OpenCV.createObject(ObjectType.Scalar, 0, 255, 255, 255), 2, LineTypes.LINE_8);

            const singleOptionWidth = (colWidth - optionsStartOffset) / 4;
            for (let opt = 0; opt < 4; opt++) {
              const oX = startX + optionsStartOffset + (opt * singleOptionWidth);
              const oPt1 = OpenCV.createObject(ObjectType.Point, oX, colStartY);
              const oPt2 = OpenCV.createObject(ObjectType.Point, oX + singleOptionWidth, colStartY + colHeight);
              OpenCV.invoke('rectangle', subColsMat, oPt1, oPt2, OpenCV.createObject(ObjectType.Scalar, 0, 255, 0, 255), 2, LineTypes.LINE_8);
            }
          }

          // Rows (Step 7)
          const numRows = 20;
          const rowHeight = cRows / numRows;
          for (let r = 0; r <= numRows; r++) {
            const y = r * rowHeight;
            OpenCV.invoke('line', rowsMat, OpenCV.createObject(ObjectType.Point, 0, y), OpenCV.createObject(ObjectType.Point, cCols, y), OpenCV.createObject(ObjectType.Scalar, 255, 165, 0, 255), 2, LineTypes.LINE_8);
          }

          // Scoring (Step 8)
          const cellPadding = 2;
          for (let c = 0; c < numCols; c++) {
            let startX, colWidth, colStartY, colHeight;
            if (answerColumns.length === numCols) {
              startX = answerColumns[c].x; colWidth = answerColumns[c].w; colStartY = answerColumns[c].y; colHeight = answerColumns[c].h;
            } else {
              const mathColWidth = (cCols - 58) / 5; startX = 21 + (c * (mathColWidth + 15)); colWidth = mathColWidth; colStartY = 0; colHeight = cRows;
            }
            const rH = colHeight / numRows;
            const singleOptionWidth = (colWidth - optionsStartOffset) / 4;

            for (let r = 0; r < numRows; r++) {
              const rowY = colStartY + (r * rH);
              let bestOpt = -1; let bestScore = -1;
              for (let opt = 0; opt < 4; opt++) {
                const bubbleX = startX + optionsStartOffset + (opt * singleOptionWidth);
                let sX = Math.max(0, Math.round(bubbleX + cellPadding));
                let sY = Math.max(0, Math.round(rowY + cellPadding));
                let sW = Math.min(cCols - sX, Math.round(singleOptionWidth - 2 * cellPadding));
                let sH = Math.min(cRows - sY, Math.round(rH - 2 * cellPadding));
                if (sW <= 0 || sH <= 0) continue;
                const cellMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
                OpenCV.invoke('crop', croppedMat, cellMat, OpenCV.createObject(ObjectType.Rect, sX, sY, sW, sH));
                const count = (OpenCV.invoke('countNonZero', cellMat) as any).value;
                if (count > bestScore) { bestScore = count; bestOpt = opt; }
              }
              if (bestScore > 20 && bestOpt !== -1) {
                const winX = startX + optionsStartOffset + (bestOpt * singleOptionWidth);
                OpenCV.invoke('rectangle', finalScoredMat, OpenCV.createObject(ObjectType.Point, winX, rowY), OpenCV.createObject(ObjectType.Point, winX + singleOptionWidth, rowY + rH), OpenCV.createObject(ObjectType.Scalar, 0, 0, 255, 255), 3, LineTypes.LINE_8);
              }
            }
          }

          // --- Step 8.5 ID Block Parsing ---
          for (const idBox of idBlocks) {
            // Assume 10 numeric rows (0-9)
            const numIdRows = 10;
            const idRowHeight = idBox.h / numIdRows;
            
            // Guess number of digits by bubble density/width
            // Standard OMR bubbles are ~25px wide + padding.
            const estimatedDigitWidth = 30;
            const numDigits = Math.round(idBox.w / estimatedDigitWidth);
            const digitWidth = idBox.w / numDigits;
            
            let detectedID = "";

            for (let d = 0; d < numDigits; d++) {
               const digitX = idBox.x + (d * digitWidth);
               let bestValue = -1;
               let bestIdScore = -1;

               for (let val = 0; val < numIdRows; val++) {
                  const valY = idBox.y + (val * idRowHeight);
                  
                  let sX = Math.max(0, Math.round(digitX + cellPadding));
                  let sY = Math.max(0, Math.round(valY + cellPadding));
                  let sW = Math.min(cCols - sX, Math.round(digitWidth - 2 * cellPadding));
                  let sH = Math.min(cRows - sY, Math.round(idRowHeight - 2 * cellPadding));
                  
                  if (sW <= 0 || sH <= 0) continue;
                  
                  const idCellMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
                  OpenCV.invoke('crop', croppedMat, idCellMat, OpenCV.createObject(ObjectType.Rect, sX, sY, sW, sH));
                  const count = (OpenCV.invoke('countNonZero', idCellMat) as any).value;
                  
                  if (count > bestIdScore) {
                     bestIdScore = count;
                     bestValue = val;
                  }
               }
               
               if (bestIdScore > 20 && bestValue !== -1) {
                  detectedID += bestValue.toString();
                  // Draw Cyan box on identified ID digit
                  const winX = idBox.x + (d * digitWidth);
                  const winY = idBox.y + (bestValue * idRowHeight);
                  OpenCV.invoke('rectangle', finalScoredMat, OpenCV.createObject(ObjectType.Point, winX, winY), OpenCV.createObject(ObjectType.Point, winX + digitWidth, winY + idRowHeight), OpenCV.createObject(ObjectType.Scalar, 255, 255, 0, 255), 3, LineTypes.LINE_8);
               } else {
                  detectedID += "?";
               }
            }
            console.log(`[OMR] 🆔 Detected Student ID: ${detectedID}`);
          }

          // Save Mats
          const save = (mat: any, prefix: string) => {
            const name = `${RNFS.CachesDirectoryPath}/omr_${prefix}_${Date.now()}.jpg`;
            OpenCV.saveMatToFile(mat, name, 'jpeg', 0.8);
            return `file://${name}`;
          };
          croppedPath = save(colorCroppedMat, 'cropped');
          majorBoxesPath = save(majorMat, 'major');
          scoredPath = save(scoredMat, 'scored');
          subColumnsPath = save(subColsMat, 'subcols');
          rowsPath = save(rowsMat, 'rows');
          finalScoredPath = save(finalScoredMat, 'final');
        }
      }

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
      console.log('[OMR] Error:', e);
      OpenCV.clearBuffers();
      throw e;
    }
  }
}
