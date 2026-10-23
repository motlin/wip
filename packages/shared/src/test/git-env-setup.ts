// Vitest setup file shared by every package: runs in each worker before any test module loads.
import {sanitizeGitEnv} from "./git-env.js";

sanitizeGitEnv(process.env);
