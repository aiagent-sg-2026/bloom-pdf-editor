export async function commitThenCleanup(
  commit: () => Promise<void>,
  cleanup: () => void,
): Promise<void> {
  await commit();
  cleanup();
}
