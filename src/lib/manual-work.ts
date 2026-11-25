export const currentManualTasks = (tasks: readonly string[]): string[] => tasks.filter((task) =>
  !/label colou?rs:/i.test(task) && !/^Mark .+ final in /i.test(task),
);
