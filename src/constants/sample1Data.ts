export const SAMPLE1_TEMPLATE = {
  "pageDimensions": [1846, 1500],
  "bubbleDimensions": [40, 40],
  "fieldBlocks": {
    "Roll": {
      "fieldType": "QTYPE_INT",
      "fieldLabels": ["roll1..9"],
      "bubblesGap": 46,
      "labelsGap": 58,
      "origin": [225, 282]
    },
    "MCQ_Block_Q1": {
      "fieldType": "QTYPE_MCQ4",
      "fieldLabels": ["q1..4"],
      "bubblesGap": 59,
      "labelsGap": 50,
      "origin": [121, 860]
    }
  }
};

export const SAMPLE1_EVALUATION = {
  "marking_schemes": {
    "DEFAULT": {
      "correct": 4,
      "incorrect": -1,
      "unmarked": 0
    }
  },
  "answers": {
    "q1": "B",
    "q2": "A",
    "q3": "C",
    "q4": "B"
  }
};
