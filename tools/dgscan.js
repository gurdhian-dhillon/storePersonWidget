#!/usr/bin/env node
// Comment- and string-aware static checks for Deluge .dg files.
//
// Deluge cannot be run here, so these are the text-level faults that Creator
// only reports at runtime, usually against the wrong line. Each check exists
// because the fault it catches actually happened in this repo - see CLAUDE.md.
//
//   usage: node dgscan.js <file.dg> [more.dg ...]
//          node dgscan.js deluge/**/*.dg

const fs = require('fs');

// Strip strings and comments, keeping line numbers intact, so every structural
// check below sees code only. A brace inside a comment or a quoted JSON
// fragment is not a brace - and this file is full of hand-built JSON.
function strip(src) {
  const out = [];
  let i = 0, line = 1, inStr = false, inLine = false, inBlock = false;
  const marks = []; // per-char: null when masked out
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '\n') { line++; inLine = false; out.push('\n'); i++; continue; }
    if (inLine || inBlock) {
      if (inBlock && c === '*' && n === '/') { inBlock = false; out.push('  '); i += 2; continue; }
      out.push(' '); i++; continue;
    }
    if (inStr) {
      if (c === '\\') { out.push('  '); i += 2; continue; }
      if (c === '"') { inStr = false; out.push(' '); i++; continue; }
      out.push(' '); i++; continue;
    }
    if (c === '/' && n === '/') { inLine = true; out.push('  '); i += 2; continue; }
    // Deluge line comments also appear as a lone backslash in this repo.
    if (c === '\\' && (n === ' ' || n === '\t')) { inLine = true; out.push('  '); i += 2; continue; }
    if (c === '/' && n === '*') { inBlock = true; out.push('  '); i += 2; continue; }
    if (c === '"') { inStr = true; out.push(' '); i++; continue; }
    out.push(c); i++;
  }
  return out.join('');
}

function lineOf(src, idx) { return src.slice(0, idx).split('\n').length; }

function checkBalance(code, src, problems) {
  const pairs = { '}': '{', ')': '(', ']': '[' };
  const stack = [];
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '{' || c === '(' || c === '[') stack.push({ c, i });
    else if (pairs[c]) {
      const top = stack.pop();
      if (!top) problems.push(`line ${lineOf(src, i)}: unmatched closing '${c}'`);
      else if (top.c !== pairs[c])
        problems.push(`line ${lineOf(src, i)}: '${c}' closes '${top.c}' opened at line ${lineOf(src, top.i)}`);
    }
  }
  for (const s of stack) problems.push(`line ${lineOf(src, s.i)}: '${s.c}' never closed`);
}

// A // line inside an `insert into X [ ... ]` field list is a SYNTAX ERROR, and
// Creator blames the function's opening try - 1,870 lines away in issueMaterials.
function checkInsertComments(src, problems) {
  const lines = src.split('\n');
  let depth = 0, active = false, startLine = 0;
  lines.forEach((raw, idx) => {
    if (!active && /\binsert\s+into\b/.test(raw)) { active = true; depth = 0; startLine = idx + 1; }
    if (!active) return;
    const code = strip(raw);
    for (const ch of code) { if (ch === '[') depth++; else if (ch === ']') depth--; }
    const t = raw.trim();
    if (depth > 0 && (t.startsWith('//') || t.startsWith('\\ '))) {
      problems.push(`line ${idx + 1}: comment inside the 'insert into' field list opened at line ${startLine} - Deluge reports this against the function's opening try`);
    }
    if (depth <= 0 && idx + 1 > startLine) active = false;
  });
}

// A name bound by `for each x in Form[...]` can never also hold a scalar
// anywhere in the same function. Deluge rejects the QUERY and blames the
// for each line, nowhere near the assignment that caused it.
function checkLoopVarClash(code, src, problems) {
  const queryLoop = /for\s+each\s+(\w+)\s+in\s+\w+\s*\[/g;
  const bound = new Map();
  let m;
  while ((m = queryLoop.exec(code))) if (!bound.has(m[1])) bound.set(m[1], lineOf(src, m.index));
  for (const [name, atLine] of bound) {
    const assign = new RegExp(`(^|[^.\\w])${name}\\s*=[^=]`, 'g');
    let a;
    while ((a = assign.exec(code))) {
      const ln = lineOf(src, a.index);
      problems.push(`line ${ln}: '${name}' is assigned as a scalar but is bound to a query result by the 'for each' at line ${atLine}`);
    }
  }
}

// sort by must be its own assignment, never inline in a for each header.
function checkInlineSort(code, src, problems) {
  const re = /for\s+each\s+\w+\s+in\s+[^\n]*\bsort\s+by\b/g;
  let m;
  while ((m = re.exec(code))) problems.push(`line ${lineOf(src, m.index)}: 'sort by' inline in a 'for each' header - give it its own assignment`);
}

// There is no reliable break in a Deluge for each.
function checkBreak(code, src, problems) {
  const re = /(^|[^.\w])break\s*;/g;
  let m;
  while ((m = re.exec(code))) problems.push(`line ${lineOf(src, m.index)}: 'break' is not reliable in a Deluge for each - guard the body with an if instead`);
}

let bad = 0;
for (const file of process.argv.slice(2)) {
  const src = fs.readFileSync(file, 'utf8');
  const code = strip(src);
  const problems = [];
  checkBalance(code, src, problems);
  checkInsertComments(src, problems);
  checkLoopVarClash(code, src, problems);
  checkInlineSort(code, src, problems);
  checkBreak(code, src, problems);
  if (problems.length) {
    bad++;
    console.log(`\n${file}`);
    for (const p of problems) console.log(`  ${p}`);
  }
}
console.log(bad ? `\n${bad} file(s) with findings.` : 'clean.');
