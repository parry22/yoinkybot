import { withTransaction } from "../db/pool.js";

/**
 * Forget is REAL deletion, immediately and irreversibly — the product's trust
 * foundation. Removes the memory, its links (FK cascade), scrubs it from
 * surfacing records, and removes positions that were sourced solely from it.
 */
export async function forgetMemory(userId: string, memoryId: string): Promise<boolean> {
  return withTransaction(async (client) => {
    const owned = await client.query(`SELECT 1 FROM memories WHERE id = $1 AND user_id = $2`, [
      memoryId,
      userId,
    ]);
    if (owned.rowCount === 0) return false;

    await client.query(
      `DELETE FROM positions
       WHERE user_id = $1 AND source_memory_ids = ARRAY[$2]::uuid[]`,
      [userId, memoryId],
    );
    await client.query(
      `UPDATE positions SET source_memory_ids = array_remove(source_memory_ids, $2)
       WHERE user_id = $1 AND $2 = ANY(source_memory_ids)`,
      [userId, memoryId],
    );
    await client.query(
      `UPDATE surfacings SET memory_ids = array_remove(memory_ids, $2)
       WHERE user_id = $1 AND $2 = ANY(memory_ids)`,
      [userId, memoryId],
    );
    await client.query(
      `UPDATE clusters SET memory_ids = array_remove(memory_ids, $2)
       WHERE user_id = $1 AND $2 = ANY(memory_ids)`,
      [userId, memoryId],
    );
    // memory_links rows cascade with the memory row.
    await client.query(`DELETE FROM memories WHERE id = $1`, [memoryId]);
    return true;
  });
}
