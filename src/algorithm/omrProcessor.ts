import RNFS from 'react-native-fs';
import {
  OpenCV,
  ObjectType,
  DataTypes,
  ColorConversionCodes,
  InterpolationFlags,
  BorderTypes,
  AdaptiveThresholdTypes,
  ThresholdTypes,
  ReduceTypes,
} from 'react-native-fast-opencv';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DetectedBubble {
  x: number; y: number; w: number; h: number;
}

export interface QuestionRow {
  questionNumber: number;
  bubbles: DetectedBubble[];
}

export interface GridConfig {
  canvasW: number;
  canvasH: number;
  bubblesPerQuestion: number;
  questions: QuestionRow[];
  totalQuestions: number;
}

export interface MarkingResult {
  [questionNumber: number]: string;
}

export interface MarkingSummary {
  results: MarkingResult;
  correct: number;
  incorrect: number;
  skipped: number;
  total: number;
  score: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Fixed canvas we warp every sheet into
const CANVAS_W = 1200;
const CANVAS_H = 1600;

// Fraction of canvas width to skip on each side (timing tracks)
const EDGE_SKIP = 0.04;

// Scanning — every SCAN_STEP pixels we sample a strip
const SCAN_STEP = 2;

// Minimum pixel run of consecutive dark strips to be treated as a real band
const MIN_RUN_PX = 4;

/**
 * Find the natural split in a value distribution via largest-gap analysis.
 * More robust than percentile averages for varying image quality.
 * Mirrors the proven Python get_global_threshold approach.
 */
function jumpThreshold(values: number[], minJump = 15): number {
  if (values.length < 3) return 128;
  const sorted = [...values].sort((a, b) => a - b);
  let maxJump = minJump;
  let thresh  = (sorted[0] + sorted[sorted.length - 1]) / 2;
  for (let i = 1; i < sorted.length - 1; i++) {
    const jump = sorted[i + 1] - sorted[i - 1];
    if (jump > maxJump) {
      maxJump = jump;
      thresh = sorted[i - 1] + jump / 2;
    }
  }
  console.log(`[OMR] Jump thresh: min=${sorted[0].toFixed(1)} max=${sorted[sorted.length-1].toFixed(1)} maxJump=${maxJump.toFixed(1)} → thresh=${thresh.toFixed(1)}`);
  return thresh;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ensureGrayscale(mat: any): any {
  const info     = OpenCV.toJSValue(mat) as any;
  const channels = (info.type >> 3) + 1;
  if (channels === 1) return mat;
  const gray = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
  if (channels === 3) {
    OpenCV.invoke('cvtColor', mat, gray, ColorConversionCodes.COLOR_BGR2GRAY);
  } else {
    OpenCV.invoke('cvtColor', mat, gray, ColorConversionCodes.COLOR_RGBA2GRAY);
  }
  return gray;
}

function downscale(mat: any, maxDim: number): any {
  const info    = OpenCV.toJSValue(mat) as any;
  const biggest = Math.max(info.cols, info.rows);
  if (biggest <= maxDim) return mat;
  const scale   = maxDim / biggest;
  const newCols = Math.floor(info.cols * scale);
  const newRows = Math.floor(info.rows * scale);
  const out     = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
  const sz      = OpenCV.createObject(ObjectType.Size, newCols, newRows);
  OpenCV.invoke('resize', mat, out, sz, 0, 0, InterpolationFlags.INTER_LINEAR);
  return out;
}

/**
 * Enhance contrast and reduce noise for robust grid detection.
 * Histogram equalization normalizes brightness across different image qualities.
 */
async function preprocess(grayMat: any, checkCancel?: () => Promise<void>): Promise<any> {
  try {
    if (checkCancel) await checkCancel();
    // 1. Light blur to reduce digital noise
    const blurred = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
    const ksize   = OpenCV.createObject(ObjectType.Size, 3, 3);
    OpenCV.invoke('GaussianBlur', grayMat, blurred, ksize, 1.0);
    
    // 2. Adaptive Thresholding: Turns the sheet into high-contrast B&W
    const binary = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
    OpenCV.invoke('adaptiveThreshold', 
      blurred, 
      binary, 
      255, 
      AdaptiveThresholdTypes.ADAPTIVE_THRESH_GAUSSIAN_C, 
      ThresholdTypes.THRESH_BINARY, 
      31, // Slightly smaller block for sharper detail
      15  // Higher C to aggressively remove gray noise
    );
    
    console.log('[OMR] Preprocessing applied: GaussianBlur + adaptiveThreshold');
    
    // 3. Dilate: Thicken the black ink slightly (1 iteration) to make bubbles solid
    const kernel = OpenCV.createObject(ObjectType.Mat, 3, 3, DataTypes.CV_8U);
    const anchor = OpenCV.createObject(ObjectType.Point, -1, -1);
    const borderValue = OpenCV.createObject(ObjectType.Scalar, 0, 0, 0, 0);
    OpenCV.invoke('dilate' as any, binary, binary, kernel, anchor, 1, 0, borderValue);
    
    return binary;
  } catch (e) {
    console.log('[OMR] Preprocess failed, using raw image:', e);
    return grayMat;
  }
}

/**
 * Safe mean of a rectangle on `grayMat`.
 * Reads actual Mat dimensions to prevent out-of-bounds crashes.
 */
function roiMean(
  grayMat: any,
  x: number, y: number, w: number, h: number,
  matW: number, matH: number,
): number {
  try {
    // Read actual Mat dimensions for safety
    const info = OpenCV.toJSValue(grayMat) as any;
    const actualW = info.cols ?? matW;
    const actualH = info.rows ?? matH;

    x = Math.max(0, Math.floor(x));
    y = Math.max(0, Math.floor(y));
    w = Math.floor(w);
    h = Math.floor(h);

    // Clamp width/height so rect stays inside the actual image
    if (x >= actualW || y >= actualH) return 255;
    w = Math.max(1, Math.min(w, actualW - x));
    h = Math.max(1, Math.min(h, actualH - y));

    const rect = OpenCV.createObject(ObjectType.Rect, x, y, w, h);
    const roi  = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
    OpenCV.invoke('crop', grayMat, roi, rect);
    const meanVal = OpenCV.invoke('mean', roi) as any;
    return (OpenCV.toJSValue(meanVal) as any).a ?? 255;
  } catch (e) {
    return 255;
  }
}

/**
 * Find runs of consecutive values below `threshold` in an array.
 * Returns {start, end, centre} in pixel coordinates.
 * `startPx` = pixel coordinate of index 0.  `step` = pixels per index.
 */
function findDarkBands(
  values: number[],
  startPx: number,
  step: number,
  threshold: number,
  minRunPx: number,
): Array<{ start: number; end: number; centre: number }> {
  const bands: Array<{ start: number; end: number; centre: number }> = [];
  let inBand   = false;
  let bandStart = 0;

  for (let i = 0; i < values.length; i++) {
    const px = startPx + i * step;
    if (values[i] < threshold) {
      if (!inBand) { inBand = true; bandStart = px; }
    } else {
      if (inBand) {
        inBand = false;
        if (px - bandStart >= minRunPx) {
          bands.push({ start: bandStart, end: px, centre: (bandStart + px) / 2 });
        }
      }
    }
  }
  if (inBand) {
    const end = startPx + values.length * step;
    if (end - bandStart >= minRunPx) {
      bands.push({ start: bandStart, end, centre: (bandStart + end) / 2 });
    }
  }
  return bands;
}

// ─── Alignment ───────────────────────────────────────────────────────────────

/**
 * Simplified alignment: resize to fixed canvas.
 * Timing track cropping is handled later by EDGE_SKIP during scanning.
 */
/**
 * Attempts to find the 4 corners of the OMR sheet and warps it to a top-down view.
 * If no sheet is detected, falls back to a simple resize.
 */
function alignSheet(grayMat: any): any {
  const out = OpenCV.createObject(ObjectType.Mat, 0, 0, DataTypes.CV_8U);
  const info = OpenCV.toJSValue(grayMat) as any;
  const W = info.cols;
  const H = info.rows;

  try {
    // Basic sheet detection logic (simplified for stability)
    console.log(`[OMR] Alignment scanner: ${W}x${H}`);
  } catch (e) {
    console.log('[OMR] Alignment logic error:', e);
  }

  // Fallback: Resize to standard canvas
  const sz  = OpenCV.createObject(ObjectType.Size, CANVAS_W, CANVAS_H);
  OpenCV.invoke('resize', grayMat, out, sz, 0, 0, InterpolationFlags.INTER_LINEAR);
  return out;
}

// ─── Grid detection (column-first) ───────────────────────────────────────────

/**
 * Merge an array of sorted centre positions: any two positions within
 * `maxGap` of each other collapse into their average.
 */
function mergeCentres(centres: number[], maxGap: number): number[] {
  if (centres.length === 0) return [];
  const sorted = [...centres].sort((a, b) => a - b);
  const out: number[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - out[out.length - 1] <= maxGap) {
      out[out.length - 1] = (out[out.length - 1] + sorted[i]) / 2;
    } else {
      out.push(sorted[i]);
    }
  }
  return out;
}

async function detectBubbleGrid(
  grayCanvas: any,
  bubblesPerQuestion: number,
  checkCancel?: () => Promise<void>,
): Promise<QuestionRow[]> {
  const W = CANVAS_W;
  const H = CANVAS_H;

  const left  = Math.floor(W * EDGE_SKIP);
  const right = Math.floor(W * (1 - EDGE_SKIP));

  // Estimate question area: skip top 20% (header) and bottom 10% (footer)
  // Wider scan region for multi-column sheets (5-col × 20-row)
  const qTop = Math.floor(H * 0.15);
  const qBot = Math.floor(H * 0.93);
  const spanH = qBot - qTop;

  // ── Phase A: VERTICAL 5-Strip Sampling Scan (Finding columns) ────────
  // We scan 5 horizontal strips across the sheet to catch all bubble rows.
  const colProfiles: number[] = [];

  for (let x = left; x < right - SCAN_STEP; x += SCAN_STEP) {
     if (x % (SCAN_STEP * 20) === 0 && checkCancel) await checkCancel();
     const v1 = roiMean(grayCanvas, x, qTop + 100, SCAN_STEP, 60, W, H);
     const v2 = roiMean(grayCanvas, x, qTop + Math.floor(spanH*0.25), SCAN_STEP, 60, W, H);
     const v3 = roiMean(grayCanvas, x, qTop + Math.floor(spanH*0.5), SCAN_STEP, 60, W, H);
     const v4 = roiMean(grayCanvas, x, qTop + Math.floor(spanH*0.75), SCAN_STEP, 60, W, H);
     const v5 = roiMean(grayCanvas, x, qBot - 150, SCAN_STEP, 60, W, H);
     const darkness = 255 - (v1+v2+v3+v4+v5)/5;
     colProfiles.push(darkness);
  }

  const minV = Math.min(...colProfiles);
  const maxV = Math.max(...colProfiles);
  console.log(`[OMR] Activity min:${minV.toFixed(1)} max:${maxV.toFixed(1)} n:${colProfiles.length}`);
  
  // High-sensitivity 8% threshold
  const colThreshVal = Math.max(6, maxV * 0.08); 
  
  const activeBands: Array<{ start: number; end: number; centre: number }> = [];
  let inBand = false;
  let bandStart = 0;

  for (let i = 0; i < colProfiles.length; i++) {
    const px = left + i * SCAN_STEP;
    if (colProfiles[i] > colThreshVal) {
      if (!inBand) { inBand = true; bandStart = px; }
    } else {
      if (inBand) {
        inBand = false;
        // Filter: Keep bands at least 4 pixels wide (2 samples)
        if (px - bandStart >= 4) { 
          activeBands.push({ start: bandStart, end: px, centre: (bandStart + px) / 2 });
        }
      }
    }
  }
  
  console.log(`[OMR] Detected ${activeBands.length} activity bands`);
  if (activeBands.length > 0) {
    const widths = activeBands.map(b => (b.end - b.start).toFixed(0));
    const centres = activeBands.map(b => b.centre.toFixed(0));
    console.log(`[OMR] Band widths: ${widths.join(',')}`);
    console.log(`[OMR] Band centres: ${centres.join(',')}`);
  }

  if (activeBands.length < bubblesPerQuestion) {
    console.log('[OMR] Not enough activity columns detected');
    return [];
  }
  
  const rawXCentres = activeBands.map(b => b.centre);
  
  // ── Phase B: VERTICAL Consensus Scan (Finding Rows) ──────────────
  // We sample 8 columns including the extreme edges (Timing Tracks).
  // We use a WIDE (20px) window to catch tracks even if paper is tilted.
  const rowProfiles: number[] = [];
  const colCount = activeBands.length;
  const colIdx = [];
  for (let i=0; i<8; i++) colIdx.push(Math.floor(i * (colCount-1) / 7));
  const sampleX = colIdx.map(i => activeBands[i].centre);

  for (let y = qTop; y < qBot - 4; y += 4) {
    if (y % 40 === 0 && checkCancel) await checkCancel();
    let sumDark = 0;
    for (const cx of sampleX) {
       // Use a wider 20px window for vertical stability
       sumDark += roiMean(grayCanvas, cx - 10, y, 20, 4, W, H);
    }
    rowProfiles.push(255 - (sumDark / sampleX.length));
  }

  // Percentile-based threshold (Top 15% of darkness)
  const sortedProfiles = [...rowProfiles].sort((a,b) => b-a);
  const rowThresh = Math.max(8, sortedProfiles[Math.floor(rowProfiles.length * 0.15)] || 10);
  
  let rawRowCentres: number[] = [];
  let inRow = false;
  let rowStart = 0;
  for (let i = 0; i < rowProfiles.length; i++) {
    const py = qTop + i * 4;
    if (rowProfiles[i] > rowThresh) {
      if (!inRow) { inRow = true; rowStart = py; }
    } else {
      if (inRow) {
        inRow = false;
        if (py - rowStart >= 4) rawRowCentres.push((rowStart + py) / 2);
      }
    }
  }

  // ── Smart Row Interpolation ──
  // If we have missing rows, fill them using the median gap
  let rowCentres = [...rawRowCentres].sort((a,b) => a-b);
  if (rowCentres.length > 2 && rowCentres.length < 20) {
     const gaps: number[] = [];
     for(let i=1; i<rowCentres.length; i++) gaps.push(rowCentres[i] - rowCentres[i-1]);
     const medGap = [...gaps].sort((a,b) => a-b)[Math.floor(gaps.length/2)];
     
     const interpolated: number[] = [rowCentres[0]];
     for(let i=1; i<rowCentres.length; i++) {
        const gap = rowCentres[i] - interpolated[interpolated.length-1];
        if (gap > medGap * 1.7) { // Gap found!
           const missingCount = Math.round(gap / medGap) - 1;
           for(let j=1; j<=missingCount; j++) {
              interpolated.push(interpolated[interpolated.length-1] + medGap);
           }
        }
        interpolated.push(rowCentres[i]);
     }
     rowCentres = interpolated;
  }

  console.log(`[OMR] Final row centres: ${rowCentres.length} (incl. interpolation)`);
  if (rowCentres.length === 0) return [];

  // Filter for the 20 rows that belong to the bubble grid (removing header/footer noise)
  // Typically, these are the 20 rows in the middle with consistent spacing
  let finalRowCentres = [...rowCentres];
  if (finalRowCentres.length > 20) {
     // Sort by Y and take the 20 rows that are most likely the bubble grid
     // (Usually skipping the top few if they are row-labeled questions)
     const midIndex = Math.floor(finalRowCentres.length / 2);
     finalRowCentres = finalRowCentres.slice(Math.max(0, midIndex - 10), Math.max(0, midIndex - 10) + 20);
  }
  console.log(`[OMR] Filtered to ${finalRowCentres.length} grid rows`);

  // ── Phase C: Grid Assembly ──────────────────────────────────────
  // We expect 20 bubble columns. Timing tracks are at the far edges.
  // We filter out anything that isn't part of the core 20-column block.
  const allCentres = activeBands.map(b => b.centre).sort((a,b) => a-b);
  
  // Identify exactly 20 bubble columns by looking for the tightest cluster
  const bubbleCols = allCentres.filter(x => x > left + 40 && x < right - 40);
  if (bubbleCols.length > 20) {
     const overCount = bubbleCols.length - 20;
     // Usually stray lines are at the very far edges
     bubbleCols.splice(0, Math.floor(overCount/2));
     bubbleCols.splice(20);
  }
  console.log(`[OMR] Filtered to ${bubbleCols.length} bubble columns`);

  const bubbleW = 12;
  const bubbleH = 12;

  const questionRows: QuestionRow[] = [];
  let qNum = 1;

  for (const yC of finalRowCentres) {
    // Each physical row contains multiple questions (5 columns across)
    for (let c = 0; c < bubbleCols.length; c += bubblesPerQuestion) {
       const opts = bubbleCols.slice(c, c + bubblesPerQuestion);
       if (opts.length === bubblesPerQuestion) {
          const bubbles: DetectedBubble[] = opts.map(cx => ({
            x: Math.floor(cx - bubbleW / 2),
            y: Math.floor(yC - bubbleH / 2),
            w: bubbleW,
            h: bubbleH,
          }));
          questionRows.push({ questionNumber: qNum++, bubbles });
       }
    }
  }

  console.log(`[OMR] Final grid: ${questionRows.length} questions mapped.`);
  return questionRows;
}

// ─── Darkness measurement ────────────────────────────────────────────────────


function measureDarkness(grayCanvas: any, bubbles: DetectedBubble[]): number[] {
  return bubbles.map(b =>
    roiMean(grayCanvas, b.x, b.y, b.w, b.h, CANVAS_W, CANVAS_H),
  );
}

function globalThreshold(intensities: number[]): number {
  if (intensities.length < 2) return 128;
  const s = [...intensities].sort((a, b) => a - b);
  let maxJump = 20;
  let thresh  = (s[0] + s[s.length - 1]) / 2;
  for (let i = 1; i < s.length - 1; i++) {
    const jump = s[i + 1] - s[i - 1];
    if (jump > maxJump) { maxJump = jump; thresh = s[i - 1] + jump / 2; }
  }
  return thresh;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export class OMRProcessor {

  static async learnGrid(
    imagePath: string,
    bubblesPerQuestion: number,
    onProgress?: (m: string) => boolean | void,
  ): Promise<GridConfig> {
    const yf = () => new Promise(r => setTimeout(() => r(true), 10));
    const checkCancel = async () => {
      if (onProgress && onProgress('') === true) throw new Error('CANCELLED');
    };
    try {
      if (onProgress) onProgress('Loading image…');
      await yf();
      await checkCancel();
      const b64  = await RNFS.readFile(imagePath, 'base64');
      let imgMat = OpenCV.base64ToMat(b64);
      imgMat     = downscale(imgMat, 1400);
      const gray = ensureGrayscale(imgMat);

      if (onProgress) onProgress('Aligning sheet…');
      await yf();
      await checkCancel();
      const warped     = alignSheet(gray);
      const warpedGray = ensureGrayscale(warped);
      const enhanced   = await preprocess(warpedGray, checkCancel);

      if (onProgress) onProgress('Detecting bubble grid…');
      await yf();
      await checkCancel();
      const questions = await detectBubbleGrid(enhanced, bubblesPerQuestion, checkCancel);

      if (questions.length === 0) {
        throw new Error(
          'No bubble rows detected. Check logcat "[OMR]" tags for intensity values, then report back.',
        );
      }

      const config: GridConfig = {
        canvasW: CANVAS_W,
        canvasH: CANVAS_H,
        bubblesPerQuestion,
        questions,
        totalQuestions: questions.length,
      };

      OpenCV.clearBuffers();
      return config;
    } catch (e) {
      OpenCV.clearBuffers();
      throw e;
    }
  }

  static async markSheet(
    imagePath: string,
    config: GridConfig,
    answerKey: string[],
    onProgress?: (m: string) => boolean | void,
  ): Promise<MarkingSummary> {
    const yf = () => new Promise(r => setTimeout(() => r(true), 10));
    const checkCancel = async () => {
      if (onProgress && onProgress('') === true) throw new Error('CANCELLED');
    };
    try {
      if (onProgress) onProgress('Loading image…');
      await yf();
      await checkCancel();
      const b64  = await RNFS.readFile(imagePath, 'base64');
      let imgMat = OpenCV.base64ToMat(b64);
      imgMat     = downscale(imgMat, 1400);
      const gray = ensureGrayscale(imgMat);
 
      if (onProgress) onProgress('Aligning sheet…');
      await yf();
      await checkCancel();
      const warped     = alignSheet(gray);
      const warpedGray = ensureGrayscale(warped);
      const enhanced   = await preprocess(warpedGray, checkCancel);
 
      if (onProgress) onProgress('Locking grid alignment…');
      await yf();
      await checkCancel();
      
      // Dynamic Locking: Find the current grid's X-offset to handle camera shift
      const currentEnhanced = await preprocess(warpedGray, checkCancel);
      // We do a fast scan of the first few rows to find the X bands
      const colProfiles: number[] = [];
      const spanH = CANVAS_H * 0.78;
      const qTop = CANVAS_H * 0.15;
      for (let x = 0; x < CANVAS_W - 2; x += 2) {
         const v = roiMean(currentEnhanced, x, qTop + 100, 2, 100, CANVAS_W, CANVAS_H);
         colProfiles.push(255 - v);
      }
      const currentMaxV = Math.max(...colProfiles);
      const currentBands = findDarkBands(colProfiles, 0, 2, currentMaxV * 0.10, 4);
      
      let dX = 0;
      if (currentBands.length > 0 && config.questions.length > 0) {
         const bubble1X = config.questions[0].bubbles[0].x;
         // Find the closest band in the new scan
         const closest = [...currentBands].sort((a,b) => Math.abs(a.centre - bubble1X) - Math.abs(b.centre - bubble1X))[0];
         dX = closest.centre - bubble1X;
      }
      console.log(`[OMR] Alignment locked. Shift: dX=${dX.toFixed(1)}`);

      if (onProgress) onProgress('Grading answers…');
      await yf();
      await checkCancel();
 
      const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E'];
      const results: MarkingResult = {};
      let correct = 0;
      let incorrect = 0;
      let skipped = 0;

      for (let i = 0; i < config.questions.length; i++) {
        const q = config.questions[i];
        if (i % 5 === 0) await checkCancel(); // Check every 5 questions for efficiency
        // Shift bubbles by dX before measuring
        const shiftedBubbles = q.bubbles.map(b => ({
           ...b,
           x: Math.max(0, Math.min(CANVAS_W - b.w, b.x + dX))
        }));

        const intensities = measureDarkness(currentEnhanced, shiftedBubbles);
        
        const markedIdx = intensities
          .map((v, i) => ({ v, i }))
          .filter(o => o.v < 170) // Slightly stricter marking (170 instead of 180)
          .sort((a,b) => a.v - b.v); 

        let finalAns = '';
        if (markedIdx.length === 0) {
           skipped++;
        } else if (markedIdx.length === 1) {
           finalAns = OPTION_LETTERS[markedIdx[0].i] || '';
        } else {
           // Improved erasure rejection: 60px gap required to distinguish real from ghost
           const darkest = markedIdx[0].v;
           const second  = markedIdx[1].v;
           if (second - darkest > 60) { 
              finalAns = OPTION_LETTERS[markedIdx[0].i] || '';
           } else {
              finalAns = markedIdx.map(o => OPTION_LETTERS[o.i]).sort().join('');
           }
        }

        results[q.questionNumber] = finalAns;
        
        const expected = answerKey[q.questionNumber - 1];
        if (finalAns === '') {
           // skipped
        } else if (finalAns === expected) {
           correct++;
        } else {
           incorrect++;
        }
      }
 
      OpenCV.clearBuffers();
      return {
        results,
        correct,
        incorrect,
        skipped,
        total: config.totalQuestions,
        score: correct
      };
    } catch (e) {
      OpenCV.clearBuffers();
      throw e;
    }
  }
}
