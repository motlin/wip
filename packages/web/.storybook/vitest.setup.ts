import {beforeAll, expect} from "vitest";
import {setProjectAnnotations} from "@storybook/react";
import * as projectAnnotations from "./preview";
import * as matchers from "@testing-library/jest-dom/matchers";

expect.extend(matchers);

const project = setProjectAnnotations([projectAnnotations]);

if (project.beforeAll) {
	beforeAll(project.beforeAll);
}
