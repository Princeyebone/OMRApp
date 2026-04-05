import { OpenCV, ObjectType, DataTypes, ColorConversionCodes, InterpolationFlags, BorderTypes, DecompTypes, NormTypes, MorphTypes } from 'react-native-fast-opencv';
import RNFS from 'react-native-fs';

const FIELD_TYPES: any = {
  QTYPE_INT: {
    bubbleValues: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'],
    direction: 'vertical',
  },
  QTYPE_MCQ4: { bubbleValues: ['A', 'B', 'C', 'D'], direction: 'horizontal' },
  QTYPE_MCQ5: { bubbleValues: ['A', 'B', 'C', 'D', 'E'], direction: 'horizontal' },
};

function parseRange(rangeStr: string): string[] {
  const match = rangeStr.match(/([a-zA-Z]+)(\d+)\.\.(\d+)/);
  if (match) {
    const [, prefix, start, end] = match;
    const labels: string[] = [];
    for (let i = parseInt(start); i <= parseInt(end); i++) {
      labels.push(`${prefix}${i}`);
    }
    return labels;
  }
  return [rangeStr];
}

export class OMRProcessor {
  private static ensureGrayscale(mat: any): any {
    const info = OpenCV.toJSValue(mat);
    // OpenCV types: CV_8UC1=0, CV_8UC2=8, CV_8UC3=16, CV_8UC4=24
    // We can check channels by (type >> 3) + 1
    const channels = (info.type >> 3) + 1;

    if (channels === 1) {
      return mat;
    }

    const grayMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
    if (channels === 3) {
      OpenCV.invoke('cvtColor', mat, grayMat, ColorConversionCodes.COLOR_BGR2GRAY);
    } else if (channels === 4) {
      OpenCV.invoke('cvtColor', mat, grayMat, ColorConversionCodes.COLOR_RGBA2GRAY);
    }
    return grayMat;
  }

  /**
   * Process an image using a given template.
   */
  static async processImage(imagePath: string, template: any, markerPath: string, onProgress?: (msg: string) => void): Promise<any> {
    const yieldFrame = async () => new Promise(resolve => setTimeout(() => resolve(true), 10));
    try {
      if (onProgress) onProgress("Loading...");
      await yieldFrame();
      
      // 1. Load Image and Marker from file to base64 to Mat
      const imgBase64 = await RNFS.readFile(imagePath, 'base64');
      let imgMat = OpenCV.base64ToMat(imgBase64);
      
      const markerBase64 = await RNFS.readFile(markerPath, 'base64');
      const markerMat = OpenCV.base64ToMat(markerBase64);

      // Optimization: Downscale huge camera photos to prevent OpenCV freezing/timeout
      const info = OpenCV.toJSValue(imgMat) as any;
      const maxDim = Math.max(info.cols, info.rows);
      if (maxDim > 1240) {
        if (onProgress) onProgress("Optimizing...");
        await yieldFrame();
        const scale = 1240 / maxDim;
        const newCols = Math.floor(info.cols * scale);
        const newRows = Math.floor(info.rows * scale);
        const resizedImg = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
        const newSize = OpenCV.createObject(ObjectType.Size, newCols, newRows);
        OpenCV.invoke('resize', imgMat, resizedImg, newSize, 0, 0, InterpolationFlags.INTER_LINEAR);
        imgMat = resizedImg;
      }

      // 2. Ensure both are Grayscale
      const grayMat = this.ensureGrayscale(imgMat);
      const grayMarkerMat = this.ensureGrayscale(markerMat);

      // 3. Detect Markers (Match Template in 4 corners)
      if (onProgress) onProgress("Detecting Markers...");
      await yieldFrame();
      const corners = await this.detectMarkers(grayMat, grayMarkerMat);
      if (!corners) throw new Error('Could not detect 4 markers');

      // 4. Warp Sheet to Top-Down View
      if (onProgress) onProgress("Aligning Sheet...");
      await yieldFrame();
      const warpedMat = await this.warpSheet(imgMat, corners, template);
      const warpedGrayMat = this.ensureGrayscale(warpedMat);

      // 5. Detect Bubbles based on Template ROIs
      if (onProgress) onProgress("Extracting Bubbles...");
      await yieldFrame();
      const results = await this.detectBubbles(warpedGrayMat, template);

      // 6. Cleanup Memory
      OpenCV.clearBuffers();

      return results;
    } catch (error) {
      console.error('OMR Processing Error:', error);
      throw error;
    }
  }

  private static async detectMarkers(image: any, marker: any): Promise<number[][] | null> {
    const imgInfo = OpenCV.toJSValue(image);
    const originalMarkerInfo = OpenCV.toJSValue(marker);
    
    // Use target width for marker detection (approx 1/17th of sheet width)
    const baseTargetWidth = Math.floor(imgInfo.cols / 17);
    const h = imgInfo.rows;
    const w = imgInfo.cols;
    const midH = h / 2;
    const midW = w / 2;

    const quadrants = [
      { x: 0, y: 0, w: Math.floor(midW), h: Math.floor(midH) },      // TL
      { x: Math.floor(midW), y: 0, w: Math.floor(midW), h: Math.floor(midH) },   // TR
      { x: Math.floor(midW), y: Math.floor(midH), w: Math.floor(midW), h: Math.floor(midH) },// BR
      { x: 0, y: Math.floor(midH), w: Math.floor(midW), h: Math.floor(midH) },   // BL
    ];

    const centers: number[][] = [];
    console.log(`Detecting markers in 4 quadrants...`);

    for (const quad of quadrants) {
      try {
        const rect = OpenCV.createObject(ObjectType.Rect, quad.x, quad.y, quad.w, quad.h);
        const quadMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
        OpenCV.invoke('crop', image, quadMat, rect);

        let bestScore = 0;
        let bestCenter = [0, 0];
        let bestSw = 0;

        const resMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_32F);
        const emptyMask = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
        const resizedMarker = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);

        // Search scales from 30% to 150% of the expected marker width
        const minSw = Math.max(10, Math.floor(baseTargetWidth * 0.3));
        const maxSw = Math.floor(baseTargetWidth * 1.5);

        for (let sw = minSw; sw <= maxSw; sw += 3) {
          const sh = Math.floor(sw * (originalMarkerInfo.rows / originalMarkerInfo.cols));
          const markerSize = OpenCV.createObject(ObjectType.Size, sw, sh);

          OpenCV.invoke('resize', marker, resizedMarker, markerSize, 0, 0, InterpolationFlags.INTER_LINEAR);
          OpenCV.invoke('matchTemplate', quadMat, resizedMarker, resMat, 5, emptyMask); 
          const minMax = OpenCV.invoke('minMaxLoc', resMat);

          if (minMax.maxVal > bestScore) {
            bestScore = minMax.maxVal;
            bestSw = sw;
            bestCenter = [
              minMax.maxX + quad.x + sw / 2,
              minMax.maxY + quad.y + sh / 2
            ];
          }
        }

        console.log(`Quadrant [${quad.x},${quad.y}] Best Match: ${bestScore.toFixed(4)} at (${bestCenter[0]}, ${bestCenter[1]}) with marker width ${bestSw}`);
        
        if (bestScore > 0.55) { // Strict threshold prevents picking up random noise
          centers.push(bestCenter);
        } else {
          console.warn(`Quadrant [${quad.x},${quad.y}] failed with low score: ${bestScore.toFixed(4)}`);
        }
      } catch (e: any) {
        console.error(`Error in quadrant ${quad.x},${quad.y}:`, e.message);
      }
    }

    if (centers.length < 4) {
      console.warn(`Only found ${centers.length} markers. OMR extraction may fail.`);
    }

    return centers.length === 4 ? centers : null;
  }

  private static async warpSheet(image: any, corners: number[][], template: any): Promise<any> {
    const [targetW, targetH] = template.pageDimensions;
    
    // Sort corners clockwise: TL, TR, BR, BL
    const sorted = [...corners].sort((a, b) => a[1] - b[1]);
    const tl_tr = sorted.slice(0, 2).sort((a, b) => a[0] - b[0]);
    const bl_br = sorted.slice(2, 4).sort((a, b) => a[0] - b[0]);
    const rectOrdered = [tl_tr[0], tl_tr[1], bl_br[1], bl_br[0]];

    const srcPointsArr = rectOrdered.map(p => OpenCV.createObject(ObjectType.Point2f, p[0], p[1]));
    const srcPoints = OpenCV.createObject(ObjectType.Point2fVector, srcPointsArr);
    
    const dstPointsArr = [
      OpenCV.createObject(ObjectType.Point2f, 0, 0),
      OpenCV.createObject(ObjectType.Point2f, targetW, 0),
      OpenCV.createObject(ObjectType.Point2f, targetW, targetH),
      OpenCV.createObject(ObjectType.Point2f, 0, targetH)
    ];
    const dstPoints = OpenCV.createObject(ObjectType.Point2fVector, dstPointsArr);

    console.log("Preparing getPerspectiveTransform...");
    const M = OpenCV.invoke('getPerspectiveTransform', srcPoints, dstPoints, 0);
    
    const warped = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
    const size = OpenCV.createObject(ObjectType.Size, targetW, targetH);
    
    console.log(`Executing warpPerspective with size: ${targetW}x${targetH}`);
    const borderValue = OpenCV.createObject(ObjectType.Scalar, 0, 0, 0, 0);
    OpenCV.invoke('warpPerspective', image, warped, M, size, InterpolationFlags.INTER_LINEAR, BorderTypes.BORDER_CONSTANT, borderValue);

    return warped;
  }

  private static async detectBubbles(sheet: any, template: any): Promise<any> {
    const fieldBlocks = template.fieldBlocks;
    const globalBW = template.bubbleDimensions[0];
    const globalBH = template.bubbleDimensions[1];
    const responses: any = {};
    const allIntensities: { label: string; val: string; intensity: number }[] = [];

    const sheetInfo = OpenCV.toJSValue(sheet);
    console.log(`Detecting bubbles on sheet: ${sheetInfo.cols}x${sheetInfo.rows}`);

    for (const [blockName, block] of Object.entries<any>(fieldBlocks)) {
      const typeDefaults = FIELD_TYPES[block.fieldType] || {};
      const mergedBlock = { ...typeDefaults, ...block };
      const isVertical = mergedBlock.direction === 'vertical';
      const [originX, originY] = mergedBlock.origin;
      const bVals = mergedBlock.bubbleValues;
      const [bw, bh] = mergedBlock.bubbleDimensions || [globalBW, globalBH];
      const bGap = mergedBlock.bubblesGap || bw;
      const lGap = mergedBlock.labelsGap || bh;

      const rawLabels = mergedBlock.fieldLabels || [blockName];
      const labels: string[] = [];
      rawLabels.forEach((rl: string) => labels.push(...parseRange(rl)));

      let leadX = originX;
      let leadY = originY;

      for (const label of labels) {
        let currX = leadX;
        let currY = leadY;

        for (const val of bVals) {
          if (currX >= 0 && currY >= 0 && currX + bw <= sheetInfo.cols && currY + bh <= sheetInfo.rows) {
            const rect = OpenCV.createObject(ObjectType.Rect, Math.floor(currX), Math.floor(currY), bw, bh);
            const roi = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
            OpenCV.invoke('crop', sheet, roi, rect);
            const meanScalar = OpenCV.invoke('mean', roi);
            const meanVal = (OpenCV.toJSValue(meanScalar) as any).a; 
            
            allIntensities.push({ label, val, intensity: meanVal });
          } else {
            console.warn(`Bubble [${label}:${val}] out of bounds at (${currX}, ${currY})`);
            allIntensities.push({ label, val, intensity: 255 }); // Default to empty
          }

          if (isVertical) currY += bGap; else currX += bGap;
        }

        if (isVertical) leadX += lGap; else leadY += lGap;
      }
    }

    const globalThreshold = this.getGlobalThreshold(allIntensities.map(i => i.intensity));
    console.log(`Global Threshold: ${globalThreshold.toFixed(2)}`);

    const rawResponses: any = {};
    allIntensities.forEach(i => {
      if (i.intensity < globalThreshold) {
        rawResponses[i.label] = (rawResponses[i.label] || '') + i.val;
      } else if (!rawResponses[i.label]) {
        rawResponses[i.label] = '';
      }
    });

    // Handle Custom Labels Concatenation (e.g. Roll)
    const customLabels = template.customLabels || {};
    const finalResponses: any = {};
    const usedLabels = new Set();

    for (const [customName, rawKeys] of Object.entries<string[]>(customLabels)) {
      let combined = '';
      rawKeys.forEach(rk => {
        const subLabels = parseRange(rk);
        subLabels.forEach(sl => {
          combined += rawResponses[sl] || '';
          usedLabels.add(sl);
        });
      });
      finalResponses[customName] = combined;
    }

    // Add remaining labels
    for (const [label, val] of Object.entries<string>(rawResponses)) {
      if (!usedLabels.has(label)) {
        finalResponses[label] = val;
      }
    }

    return finalResponses;
  }

  private static getGlobalThreshold(intensities: number[]): number {
    if (intensities.length < 2) return 128;
    const sorted = [...intensities].sort((a, b) => a - b);
    let maxJump = 30;
    let threshold = (sorted[0] + sorted[sorted.length - 1]) / 2;
    
    // Finding the largest jump in intensities to separate marked/unmarked
    for (let i = 1; i < sorted.length - 1; i++) {
        const jump = sorted[i + 1] - sorted[i - 1];
        if (jump > maxJump) {
            maxJump = jump;
            threshold = sorted[i - 1] + jump / 2;
        }
    }
    return threshold;
  }
}
