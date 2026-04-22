# OMR Processing Pipeline: Status & Engineering Log

This document provides a comprehensive summary of the debugging, algorithm replacements, and structural upgrades applied to `omrProcessor.ts`, outlining where the codebase stands today and the exact blockers remaining for the next session.

---

## 1. Initial State & Problem Identification

The original OpenCV algorithm in `omrProcessor.ts` utilized a heavily rigid **"Melt-and-Scan" (Morphological Closing)** approach to group A, B, C, and D bubbles into solid vertical columns so they could be scored.

It was actively failing in "Step 4" (finding major section blocks) for multiple reasons:
- **The "Giant Box / Frame" Trap:** The `findContours` operation was originally set to `RETR_EXTERNAL`. If the printed OMR paper had a decorative bounding box drawn around the edge (or if scanning artifacts left a strong margin line), OpenCV would exclusively target the page frame and go completely blind to the actual columns inside of it.
- **Micro-Slivers:** The morphological kernel was originally `[1, 150]`, bridging vertical gaps but completely failing to bridge horizontal gaps between identical questions (A and B). This caused the algorithm to generate microscopic, shattered boxes that were immediately thrown away by size filters.
- **The Column Bleed:** When the kernel width was expanded to fix the slivers, it became painfully apparent that the horizontal gap between completely different Answer Columns (e.g., 15 pixels) was physically smaller than the gap between options within the same question (16 pixels). Because of this geometry, it was mathematically impossible to use pixel-smearing morphology to group a question without causing all 5 columns to bleed into a single invincible blob. 

---

## 2. Upgrades & Algorithm Re-Architecture 

To stabilize the system and ensure the codebase scales dynamically to complex paper layouts (like sheets featuring both Answer Modules and Student ID sections), the following systems were introduced:

### Upgrade A: Pre-Process Frame Breaking
Before any box-detection begins, the algorithm now artificially paints four 40-pixel pure-black borders around the extreme edges of `croppedMat`. This acts as an eraser, permanently destroying any physical page lines or lighting noise around the margins *before* they can expand and trap the inner data.

### Upgrade B: Proximity-Based Bubble Clustering
We completely ripped out the Morphological "Melt" logic for Step 4. 
Instead of trying to physically smear pixels together, the codebase now relies on **mathematical coordinate clustering**:
1. It uses `findContours` natively without blurring to identify every single physical bubble/mark on the paper. 
2. It loops through all detected bubbles and measures their `X` and `Y` distances. 
3. If any bubbles are within 35 pixels of each other, it fuses them into a "Cluster".
4. If a Cluster achieves sufficient density (8+ bubbles), the algorithm wraps a perfectly tailored, dynamic bounding box tightly around those specific bubbles.

**Result:** The algorithm no longer guesses where columns are based on hardcoded math. It can now dynamically lock onto an isolated ID Block in the corner and tightly wrap 5 individual answer columns in the center, adapting flawlessly to whatever geometry the specific paper was printed with.

---

## 3. Current State & Where We Left Off

We have successfully forced Step 4 to recognize and isolate distinct, varying structural sections of the OMR paper using physical proximity detection.

### ⚠️ The Next Immediate Step (The Blocker)
While the detection is now dynamically adaptive, the **Scoring logic (Step 5 through Step 8)** is still structurally hardcoded to assume that **every detected block is a 20-question, 4-option answer column.**

If you load a complex sheet today, Step 4 correctly isolates the Student ID block. However, the subsequent Steps will aggressively project a 20-row Red/Blue Answer grid directly on top of the Student ID block, falsely grading the student's ID number as standard test answers. 

**Tasks to complete in the next session:**
1. **Semantic Routing:** Introduce logic to evaluate the dimensions of the detected clusters (e.g. `If width > height, it's the ID block, Route to ID Parser. If height > width, it's an Answer Column, route to standard grader.`).
2. **Build the ID Parser:** Implement a new scoring loop explicitly designed for the Student ID block that scans columns of 10 options [0-9] downward rather than [A-D] horizontally. 
