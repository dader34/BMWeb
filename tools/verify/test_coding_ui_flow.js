#!/usr/bin/env node
// The coding screens' read-show-stage-write flow.
//
// This file used to re-implement the review's logic and test the copy. The
// screens' own code is now run instead, against BMW's coding script and SGBD
// jobs and a simulated cluster, in test_coding_image.js; this name is kept
// for whoever runs it by habit.
//
//   node tools/verify/test_coding_ui_flow.js
require('./test_coding_image.js');
