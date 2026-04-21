import RNFS from 'react-native-fs';
import {
  OpenCV,
  ObjectType,
  DataTypes,
  ColorConversionCodes,
  ThresholdTypes,
  RetrievalModes,
  ContourApproximationModes,
  DecompTypes,
  InterpolationFlags,
  BorderTypes,
} from 'react-native-fast-opencv';

export class DocumentExtractor {
  /**
   * Dumb Extractor processing strategy:
   * 1. Detect document edges on a downscaled/grayscale copy (avoid altering original)
   * 2. Apply Canny edge detection & find largest 4-point contour
   * 3. Apply perspective transform (ONLY) to the raw, unmodified original image
   * 4. Enforce fixed A4 ratio & ensure no aggressive auto-rotation
   */
  static async extractDocument(imagePath: string, A4_WIDTH = 2480, A4_HEIGHT = 3508): Promise<string> {
    try {
      const cleanPath = imagePath.replace('file://', '');
      const b64 = await RNFS.readFile(cleanPath, 'base64');
      const originalMat = OpenCV.base64ToMat(b64);

      // STEP 1: Processed Image for Detection Only
      const processed = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
      OpenCV.invoke('cvtColor', originalMat, processed, ColorConversionCodes.COLOR_RGBA2GRAY);

      // Apply blur & Canny for strong edge detection
      const edges = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
      OpenCV.invoke('GaussianBlur', processed, processed, OpenCV.createObject(ObjectType.Size, 5, 5), 0);
      OpenCV.invoke('Canny', processed, edges, 75, 200, 3, false);

      // STEP 2: Find document contour
      const contours = OpenCV.createObject(ObjectType.PointVectorOfVectors);
      OpenCV.invoke('findContours', edges, contours, RetrievalModes.RETR_EXTERNAL, ContourApproximationModes.CHAIN_APPROX_SIMPLE);

      const parsedContours = OpenCV.toJSValue(contours) as any;
      const jsContours: { x: number, y: number }[][] = parsedContours?.array || [];

      if (jsContours.length === 0) {
        throw new Error('No document contour detected');
      }

      // Sort and find largest valid 4-point polygon
      const sortedContours = jsContours
        .map((pts, idx) => {
          // Manually approximate contour area using bounding box roughly to find largest candidates
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const p of pts) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
          }
          return { pts, area: (maxX - minX) * (maxY - minY), idx };
        })
        .sort((a, b) => b.area - a.area);

      // Use the bounding box of the largest contour as a fallback or exact 4 points
      const best = sortedContours[0];
      const topLeft = { x: Infinity, y: Infinity };
      const topRight = { x: -Infinity, y: Infinity };
      const bottomRight = { x: -Infinity, y: -Infinity };
      const bottomLeft = { x: Infinity, y: -Infinity };

      for (const p of best.pts) {
        if (p.x + p.y < topLeft.x + topLeft.y) topLeft = p;
        if (p.x - p.y > topRight.x - topRight.y) topRight = p;
        if (p.x + p.y > bottomRight.x + bottomRight.y) bottomRight = p;
        if (p.y - p.x > bottomLeft.y - bottomLeft.x) bottomLeft = p;
      }

      const srcPoints = [topLeft, topRight, bottomRight, bottomLeft];

      // PREVENT ROTATION: We ensure points follow natural ordering without forcing orientation correction.
      // If width > height, it's landscape, but we respect the raw camera capture orientation.
      const rawWidth = originalMat.cols;
      const rawHeight = originalMat.rows;
      const isLandscape = rawWidth > rawHeight;
      const w = isLandscape ? A4_HEIGHT : A4_WIDTH;
      const h = isLandscape ? A4_WIDTH : A4_HEIGHT;

      const dstPoints = [
        { x: 0, y: 0 },
        { x: w, y: 0 },
        { x: w, y: h },
        { x: 0, y: h }
      ];

      // STEP 3: Apply Transform to RAW, Unfiltered Image
      const srcVector = OpenCV.createObject(ObjectType.Point2fVector, srcPoints as any);
      const dstVector = OpenCV.createObject(ObjectType.Point2fVector, dstPoints as any);

      const M = OpenCV.invoke('getPerspectiveTransform', srcVector, dstVector, DecompTypes.DECOMP_LU);
      const outputMat = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
      
      OpenCV.invoke(
        'warpPerspective',
        originalMat,
        outputMat,
        M,
        OpenCV.createObject(ObjectType.Size, w, h),
        InterpolationFlags.INTER_LINEAR,
        BorderTypes.BORDER_CONSTANT,
        OpenCV.createObject(ObjectType.Scalar, 0, 0, 0, 255)
      );

      // STEP 4: Lock ratio and output as pure JPEG (dumb extraction)
      const outputPath = `${RNFS.CachesDirectoryPath}/extracted_raw_${Date.now()}.jpg`;
      OpenCV.saveMatToFile(outputMat, outputPath, 'jpeg', 1.0); // 100% quality, no compression artifacts

      return `file://${outputPath}`;
    } catch (e) {
      console.error('[DocumentExtractor]', e);
      return imagePath; // Fallback to returning original image if extraction fails
    } finally {
      OpenCV.clearBuffers();
    }
  }
}
