type NamedChoice = { id: string; name: string };
type Status = { status: string };

export function matchesGrantChoice(choice: NamedChoice, query: string): boolean {
  return (choice.name + " " + choice.id).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}

export function isActiveService(application: Status, service: Status): boolean {
  return application.status === "active" && service.status === "active";
}

export function isActiveAgent(application: Status, agent: Status & { binding: Status }): boolean {
  return application.status === "active" && agent.status === "active" && agent.binding.status === "active";
}
