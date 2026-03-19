export {getProjectsDir, getCacheDir, getTestLogDir, readConfig, writeConfig, getConfigValue, setConfigValue, unsetConfigValue} from './lib/config.js';
export {type ProjectInfo, type ChildCommit, discoverProjects, getChildren, getChildCommits, isDirty, hasUpstreamRef, hasTestConfigured} from './lib/git.js';
export {log} from './services/logger.js';
