import * as fs from "node:fs";
import * as path from "node:path";

export interface TodoTask {
  text: string;
  completed: boolean;
  sourceFile: string;
  contextLines: string[];
}

const TODO_FILENAMES = ["todo.md", "TODO.md", ".llm/todo.md"];

const TASK_PATTERN = /^- \[([ x!])\] (.+)$/;

/**
 * Parse markdown task lists from a file.
 * Extracts `- [ ]`, `- [x]`, and `- [!]` checkbox items with any indented context lines below them.
 */
export function parseTodoFile(filePath: string): TodoTask[] {
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, "utf-8");
  return parseTodoContent(content, filePath);
}

/**
 * Parse markdown task list content (testable without filesystem).
 */
export function parseTodoContent(content: string, sourceFile: string): TodoTask[] {
  const lines = content.split("\n");
  const tasks: TodoTask[] = [];
  let current: TodoTask | null = null;

  for (const line of lines) {
    const match = line.match(TASK_PATTERN);
    if (match) {
      if (current) tasks.push(current);
      current = {
        text: match[2],
        completed: match[1] === "x",
        sourceFile,
        contextLines: [],
      };
    } else if (current && line.startsWith("  ") && line.trim().length > 0) {
      current.contextLines.push(line.trimStart());
    } else if (current) {
      // Non-indented non-task line ends the current task's context
      tasks.push(current);
      current = null;
    }
  }

  if (current) tasks.push(current);

  return tasks;
}

/**
 * Scan a project directory for todo/task markdown files and return all incomplete tasks.
 */
export function findTodoTasks(projectDir: string): TodoTask[] {
  const tasks: TodoTask[] = [];

  for (const filename of TODO_FILENAMES) {
    const filePath = path.join(projectDir, filename);
    const fileTasks = parseTodoFile(filePath);
    tasks.push(...fileTasks);
  }

  return tasks;
}

/**
 * Return only incomplete tasks from a project directory.
 */
export function findIncompleteTodoTasks(projectDir: string): TodoTask[] {
  return findTodoTasks(projectDir).filter((t) => !t.completed);
}
