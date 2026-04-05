import { OpenCV, ObjectType, DataTypes, ColorConversionCodes, InterpolationFlags, BorderTypes, DecompTypes } from 'react-native-fast-opencv';
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
  static async processImage(imagePath: string, template: any, markerPath: string): Promise<any> {
    try {
      // 1. Load Image and Marker from file to base64 to Mat
      const imgBase64 = await RNFS.readFile(imagePath, 'base64');
      const imgMat = OpenCV.base64ToMat(imgBase64);
      
      const markerBase64 = await RNFS.readFile(markerPath, 'base64');
      const markerMat = OpenCV.base64ToMat(markerBase64);

      // 2. Ensure both are Grayscale
      const grayMat = this.ensureGrayscale(imgMat);
      const grayMarkerMat = this.ensureGrayscale(markerMat);

      // 3. Detect Markers (Match Template in 4 corners)
      const corners = await this.detectMarkers(grayMat, grayMarkerMat);
      if (!corners) throw new Error('Could not detect 4 markers');

      // 4. Warp Sheet to Top-Down View
      const warpedMat = await this.warpSheet(imgMat, corners, template);
      const warpedGrayMat = this.ensureGrayscale(warpedMat);

      // 5. Detect Bubbles based on Template ROIs
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
    const markerInfo = OpenCV.toJSValue(marker);
    
    console.log(`Image: ${imgInfo.cols}x${imgInfo.rows}, Channels: ${(imgInfo.type >> 3) + 1}`);
    console.log(`Marker: ${markerInfo.cols}x${markerInfo.rows}, Channels: ${(markerInfo.type >> 3) + 1}`);
    
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

    console.log(`Detecting markers in ${quadrants.length} quadrants...`);
    for (const quad of quadrants) {
      console.log(`Checking quadrant: x=${quad.x}, y=${quad.y}, w=${quad.w}, h=${quad.h}`);
      try {
        const rect = OpenCV.createObject(ObjectType.Rect, quad.x, quad.y, quad.w, quad.h);
        const quadMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
        OpenCV.invoke('crop', image, quadMat, rect);
        
        const resMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_32F);
        const maskMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
        
        OpenCV.invoke('matchTemplate', quadMat, marker, resMat, 5, maskMat); 
        const minMax = OpenCV.invoke('minMaxLoc', resMat);
        
        console.log(`Quadrant [${quad.x},${quad.y}] Best Match Value: ${minMax.maxVal.toFixed(4)}`);
        
        if (minMax.maxVal > 0.15) { // Lowered threshold to 0.15 for better robustness
          console.log(`Marker found! Score: ${minMax.maxVal.toFixed(4)}`);
          centers.push([
            minMax.maxX + quad.x + markerInfo.cols / 2,
            minMax.maxY + quad.y + markerInfo.rows / 2
          ]);
        }
      } catch (e: any) {
        console.error(`Error in quadrant ${quad.x},${quad.y}:`, e.message);
        throw e;
      }
    }

    if (centers.length < 4) {
      console.warn(`Only found ${centers.length} markers. Minimum 4 required for full perspective warp.`);
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

    const intensitiesOnly = allIntensities.map(i => i.intensity).sort((a, b) => a - b);
    const threshold = (intensitiesOnly[0] + intensitiesOnly[intensitiesOnly.length - 1]) / 2;

    allIntensities.forEach(i => {
      if (i.intensity < threshold) {
        responses[i.label] = (responses[i.label] || '') + i.val;
      }
    });

    return responses;
  }
}
