#!/usr/bin/env node
/** Admin CLI, see src/admin.ts. */
import { runAdmin } from '../src/admin.ts';

runAdmin(process.argv.slice(2));
