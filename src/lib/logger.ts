const COLORS = {
  red: "\x1b[0;31m",
  green: "\x1b[0;32m",
  yellow: "\x1b[1;33m",
  blue: "\x1b[0;34m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
} as const;

function timestamp(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

export function info(msg: string): void {
  console.log(
    `${COLORS.blue}[INFO]${COLORS.reset} ${COLORS.dim}${timestamp()}${COLORS.reset} ${msg}`,
  );
}

export function ok(msg: string): void {
  console.log(
    `${COLORS.green}[OK]${COLORS.reset} ${COLORS.dim}${timestamp()}${COLORS.reset} ${msg}`,
  );
}

export function warn(msg: string): void {
  console.log(
    `${COLORS.yellow}[WARN]${COLORS.reset} ${COLORS.dim}${timestamp()}${COLORS.reset} ${msg}`,
  );
}

export function error(msg: string): never {
  console.error(
    `${COLORS.red}[ERROR]${COLORS.reset} ${COLORS.dim}${timestamp()}${COLORS.reset} ${msg}`,
  );
  process.exit(1);
}

export function header(msg: string): void {
  console.log();
  console.log(
    `${COLORS.green}==========================================${COLORS.reset}`,
  );
  console.log(`${COLORS.green} ${msg}${COLORS.reset}`);
  console.log(
    `${COLORS.green}==========================================${COLORS.reset}`,
  );
  console.log();
}
