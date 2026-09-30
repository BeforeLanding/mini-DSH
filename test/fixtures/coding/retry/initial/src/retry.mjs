export async function retry(operation, maxAttempts) {
  return operation()
}
