#!/usr/bin/env node
// Commander entrypoint for the local CLI.
import { createProgram } from './program.js';

createProgram().parse();
