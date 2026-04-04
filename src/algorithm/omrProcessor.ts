import { OpenCV, ObjectType, DataTypes, ColorConversionCodes, InterpolationFlags } from 'react-native-fast-opencv';
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

      // 2. Convert Image to Grayscale
      const grayMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
      OpenCV.invoke('cvtColor', imgMat, grayMat, ColorConversionCodes.COLOR_BGR2GRAY);

      // 3. Detect Markers (Match Template in 4 corners)
      const corners = await this.detectMarkers(grayMat, markerMat);
      if (!corners) throw new Error('Could not detect 4 markers');

      // 4. Warp Sheet to Top-Down View
      const warpedMat = await this.warpSheet(imgMat, corners, template);
      const warpedGrayMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
      OpenCV.invoke('cvtColor', warpedMat, warpedGrayMat, ColorConversionCodes.COLOR_BGR2GRAY);

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
    const h = imgInfo.rows;
    const w = imgInfo.cols;
    
    const midH = h / 2;
    const midW = w / 2;

    const quadrants = [
      { x: 0, y: 0, w: midW, h: midH },      // TL
      { x: midW, y: 0, w: midW, h: midH },   // TR
      { x: midW, y: midH, w: midW, h: midH },// BR
      { x: 0, y: midH, w: midW, h: midH },   // BL
    ];

    const centers: number[][] = [];
    const markerInfo = OpenCV.toJSValue(marker);

    for (const quad of quadrants) {
      const rect = OpenCV.createObject(ObjectType.Rect, quad.x, quad.y, quad.w, quad.h);
      const quadMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
      OpenCV.invoke('crop', image, quadMat, rect);
      
      const resMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_32F);
      OpenCV.invoke('matchTemplate', quadMat, marker, resMat, 5); // 5 = TM_CCOEFF_NORMED
      const minMax = OpenCV.invoke('minMaxLoc', resMat);
      
      if (minMax.maxVal > 0.4) {
        centers.push([
          minMax.maxX + quad.x + markerInfo.cols / 2,
          minMax.maxY + quad.y + markerInfo.rows / 2
        ]);
      }
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

    const M = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_32F);
    OpenCV.invoke('getPerspectiveTransform', srcPoints, dstPoints, M);
    
    const warped = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
    const size = OpenCV.createObject(ObjectType.Size, targetW, targetH);
    
    OpenCV.invoke('warpPerspective', image, warped, M, size, InterpolationFlags.INTER_LINEAR);
    
    return warped;
  }

  private static async detectBubbles(sheet: any, template: any): Promise<any> {
    const fieldBlocks = template.fieldBlocks;
    const globalBW = template.bubbleDimensions[0];
    const globalBH = template.bubbleDimensions[1];
    const responses: any = {};
    const allIntensities: { label: string; val: string; intensity: number }[] = [];

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
          const rect = OpenCV.createObject(ObjectType.Rect, currX, currY, bw, bh);
          const roi = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
          OpenCV.invoke('crop', sheet, roi, rect);
          const meanScalar = OpenCV.invoke('mean', roi);
          const meanVal = (OpenCV.toJSValue(meanScalar) as any).a; 
          
          allIntensities.push({ label, val, intensity: meanVal });

          if (isVertical) currX += bGap; else currY += bGap;
        }

        if (isVertical) leadY += lGap; else leadX += lGap;
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
