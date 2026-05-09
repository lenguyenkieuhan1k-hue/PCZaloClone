'use strict'
const fs = require('fs')
const out = process.argv[2]
if (out) fs.writeFileSync(out, JSON.stringify({ argv: process.argv, execPath: process.execPath }, null, 2), 'utf8')
console.log('echo-ok')
