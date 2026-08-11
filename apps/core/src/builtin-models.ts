import type { ModelDefinition } from "./model-definition";

export const TASK_MODEL_DEFINITION: ModelDefinition = {
  definitionVersion: 1,
  key: "task",
  route: "tasks",
  display: {
    singular: "Task",
    plural: "Tasks",
  },
  fields: {
    name: {
      type: "string",
      required: true,
      minLength: 1,
      maxLength: 100,
    },
    description: {
      type: "text",
      nullable: true,
      maxLength: 5000,
    },
    dueDate: {
      type: "date",
      nullable: true,
    },
    status: {
      type: "enum",
      required: true,
      values: ["pending", "completed", "cancelled"],
    },
    assigneePersonIds: {
      type: "person_list",
    },
    completedAt: {
      type: "datetime",
      nullable: true,
      readOnly: true,
    },
    completedByType: {
      type: "enum",
      nullable: true,
      readOnly: true,
      values: ["user", "service", "device"],
    },
    completedById: {
      type: "string",
      nullable: true,
      readOnly: true,
      maxLength: 100,
    },
  },
  query: {
    searchable: ["name", "description"],
    filterable: ["status", "dueDate", "assigneePersonIds"],
    sortable: ["dueDate", "name"],
  },
  access: ["read", "write"],
  lifecycle: {
    optimisticConcurrency: true,
    softDelete: true,
  },
  actions: {
    complete: {
      access: "write",
      guards: [{
        field: "status",
        op: "neq",
        value: "completed",
        errorCode: "TASK_ALREADY_COMPLETED",
        message: "Task is already completed",
      }],
      set: {
        status: "completed",
        completedAt: { $ref: "now" },
        completedByType: { $ref: "actor.type" },
        completedById: { $ref: "actor.id" },
      },
    },
    reopen: {
      access: "write",
      guards: [{
        field: "status",
        op: "neq",
        value: "pending",
        errorCode: "TASK_ALREADY_PENDING",
        message: "Task is already pending",
      }],
      set: {
        status: "pending",
        completedAt: null,
        completedByType: null,
        completedById: null,
      },
    },
  },
};
