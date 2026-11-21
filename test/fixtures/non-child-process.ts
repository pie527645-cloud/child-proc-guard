export interface QueryRunner {
  exec(sql: string): Promise<void>;
}

export interface RedisPipeline {
  exec(): Promise<unknown[]>;
}

export async function runUnrelatedExecMethods(
  input: string,
  db: QueryRunner,
  redisPipe: RedisPipeline
): Promise<boolean> {
  const pattern = /^v1\.0\.0$/;
  const match = pattern.exec(input);

  await db.exec('SELECT 1;');
  await redisPipe.exec();

  const localSpawn = (name: string) => ({
    name,
    on(_event: string, _cb: () => void) {},
    kill() {},
  });
  const fake = localSpawn('custom-task');
  fake.on('close', () => {});
  fake.kill();

  return match !== null;
}
