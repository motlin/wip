import {z} from "zod";
import {
	GitChildResultSchema,
	ProjectInfoSchema,
	TaskTypeSchema,
	TodoItemSchema,
	TransitionSchema,
} from "@wip/shared/schemas.js";

/**
 * The SSE wire contract: every {channel, data} envelope the /api/events stream
 * carries, defined once and consumed by both ends. Producers (task queue,
 * merge queue, refresh pipeline) type their events against these schemas and
 * the client parses incoming frames with ServerEventSchema, so the two sides
 * can never silently drift — the drift that previously left this shape
 * redeclared three times.
 */

const TaskStatusSchema = z.enum(["queued", "running", "passed", "failed", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

const TaskEventSchema = z.object({
	id: z.string(),
	taskType: TaskTypeSchema,
	sha: z.string(),
	project: z.string(),
	shortSha: z.string(),
	subject: z.string(),
	branch: z.string().optional(),
	status: TaskStatusSchema,
	transition: TransitionSchema.optional(),
	message: z.string().optional(),
	compareUrl: z.string().optional(),
	type: z.enum(["status", "log"]).optional(),
	log: z.string().optional(),
});
export type TaskEvent = z.infer<typeof TaskEventSchema>;

const MergeStatusEventSchema = z.object({
	project: z.string(),
	sha: z.string(),
	commitsBehind: z.number(),
	commitsAhead: z.number(),
	rebaseable: z.boolean().nullable(),
	transition: TransitionSchema.optional(),
});
export type MergeStatusEvent = z.infer<typeof MergeStatusEventSchema>;

const WorkQueueStateEventSchema = z.object({
	slots: z.number(),
	running: z.array(z.object({kind: z.string(), project: z.string()})),
	queued: z.array(z.object({kind: z.string(), project: z.string()})),
});

const RefreshErrorEventSchema = z.object({
	kind: z.string(),
	project: z.string(),
	message: z.string(),
});

const ChildrenEventSchema = z.object({
	project: z.string(),
	children: z.array(GitChildResultSchema),
});

const TodoEventSchema = z.object({
	project: z.string(),
	todos: z.array(TodoItemSchema),
});

export const ServerEventSchema = z.discriminatedUnion("channel", [
	z.object({channel: z.literal("task"), data: TaskEventSchema}),
	z.object({channel: z.literal("merge"), data: MergeStatusEventSchema}),
	z.object({channel: z.literal("projects"), data: z.array(ProjectInfoSchema)}),
	z.object({channel: z.literal("children"), data: ChildrenEventSchema}),
	z.object({channel: z.literal("todos"), data: TodoEventSchema}),
	z.object({channel: z.literal("refresh-error"), data: RefreshErrorEventSchema}),
	z.object({channel: z.literal("refresh-state"), data: WorkQueueStateEventSchema}),
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;
