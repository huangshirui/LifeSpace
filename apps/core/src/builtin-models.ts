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
    completedByPersonId: {
      type: "person",
      nullable: true,
      readOnly: true,
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
};
