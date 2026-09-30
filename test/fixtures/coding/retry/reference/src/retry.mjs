export async function retry(operation, maxAttempts) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await operation() }
    catch (error) { if (attempt === maxAttempts) throw error }
  }
}
