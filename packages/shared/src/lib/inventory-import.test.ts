import {describe, expect, it} from "vite-plus/test";

import {buildInventoryFromTemplates, parseProjectsYaml} from "./inventory-import.js";

const javaYaml = `# Projects to sync with this template
# Each project should have a .mise/config.toml file

# Your projects
own:
    - ~/projects/liftwizard
    - ~/projects/demo/avalon

# Forks
forks:
    - ~/projects/eclipse-collections

nested:
    - ~/projects/klass/klass-maven-archetype/src/main/resources/archetype-resources
`;

const projectYaml = `# All projects
scan: ~/projects
skip:
    # Owned by others
    - ~/projects/open-source
    - ~/projects/eclipse-collections
`;

const typescriptYaml = `own:
    - ~/projects/wip
    # comment inside list
    - ~/projects/liftwizard

forks: []

nested:
    - ~/projects/quarto/web
`;

describe("parseProjectsYaml", () => {
	it("parses scalar and list keys, comments, blanks, and empty lists", () => {
		expect(parseProjectsYaml(javaYaml)).toEqual({
			own: ["~/projects/liftwizard", "~/projects/demo/avalon"],
			forks: ["~/projects/eclipse-collections"],
			nested: ["~/projects/klass/klass-maven-archetype/src/main/resources/archetype-resources"],
		});
		expect(parseProjectsYaml(projectYaml)).toEqual({
			scan: "~/projects",
			skip: ["~/projects/open-source", "~/projects/eclipse-collections"],
		});
		expect(parseProjectsYaml(typescriptYaml)).toEqual({
			own: ["~/projects/wip", "~/projects/liftwizard"],
			forks: [],
			nested: ["~/projects/quarto/web"],
		});
	});

	it("expands ~ when a home directory is given", () => {
		expect(parseProjectsYaml("scan: ~/projects\nown:\n  - ~/projects/a\n", "/home/u")).toEqual({
			scan: "/home/u/projects",
			own: ["/home/u/projects/a"],
		});
	});
});

describe("buildInventoryFromTemplates", () => {
	it("builds records per language list, skip records, and reports conflicts", () => {
		const result = buildInventoryFromTemplates(
			{java: javaYaml, project: projectYaml, typescript: typescriptYaml},
			"/home/u/projects",
		);
		expect(result.conflicts).toEqual([{dir: "/home/u/projects/liftwizard", templates: ["typescript", "java"]}]);
		expect(result.projects).toEqual([
			{name: "demo/avalon", dir: "/home/u/projects/demo/avalon", template: "java", kind: "own"},
			{name: "eclipse-collections", dir: "/home/u/projects/eclipse-collections", template: "java", kind: "fork"},
			{
				name: "klass/klass-maven-archetype/src/main/resources/archetype-resources",
				dir: "/home/u/projects/klass/klass-maven-archetype/src/main/resources/archetype-resources",
				template: "java",
				kind: "nested",
			},
			{name: "open-source", dir: "/home/u/projects/open-source", template: "project", kind: "skip"},
			{name: "quarto/web", dir: "/home/u/projects/quarto/web", template: "typescript", kind: "nested"},
			{name: "wip", dir: "/home/u/projects/wip", template: "typescript", kind: "own"},
		]);
	});

	it("marks unlisted scanned directories as project-template own repos", () => {
		const result = buildInventoryFromTemplates({java: javaYaml, project: projectYaml}, "/home/u/projects", {
			directories: ["/home/u/projects/liftwizard", "/home/u/projects/open-source", "/home/u/projects/newrepo"],
		});
		expect(result.projects.filter((p) => p.template === "project")).toEqual([
			{name: "newrepo", dir: "/home/u/projects/newrepo", template: "project", kind: "own"},
			{name: "open-source", dir: "/home/u/projects/open-source", template: "project", kind: "skip"},
		]);
	});
});
