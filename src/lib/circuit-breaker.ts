import { warn } from "./logger";

export type ServiceName = "linear" | "github";
export type CircuitState = "closed" | "open" | "half-open";

export interface BreakerConfig {
  /** Number of transient failures within windowMs before opening the circuit */
  failureThreshold: number;
  /** Time window in ms for counting failures */
  windowMs: number;
  /** How long (ms) to stay open before probing with a half-open request */
  cooldownMs: number;
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  failureThreshold: 10,
  windowMs: 60_000,
  cooldownMs: 300_000,
};

/**
 * Thrown by withRetry() when the circuit breaker for the call's service is open.
 * Zero network requests are made when this is thrown.
 */
export class CircuitOpenError extends Error {
  constructor(
    public readonly service: ServiceName,
    public readonly label: string,
  ) {
    super(`Circuit breaker open for ${service} (call: ${label})`);
    this.name = "CircuitOpenError";
  }
}

class ServiceCircuitBreaker {
  private state: CircuitState = "closed";
  private failures: number[] = []; // timestamps of transient failures
  private openedAt: number | null = null;
  private probeAllowed = false;

  constructor(private readonly config: BreakerConfig) {}

  /**
   * Returns the current logical state, lazily transitioning open → half-open
   * once the cooldown has elapsed.
   */
  getState(): CircuitState {
    if (
      this.state === "open" &&
      this.openedAt !== null &&
      Date.now() - this.openedAt >= this.config.cooldownMs
    ) {
      this.state = "half-open";
      this.probeAllowed = false;
    }
    return this.state;
  }

  /**
   * Returns true if the circuit is currently blocking requests.
   * In half-open state, allows the first caller through as a probe.
   */
  isOpen(): boolean {
    const state = this.getState();
    if (state === "closed") return false;
    if (state === "open") return true;
    // half-open: allow one probe request
    if (!this.probeAllowed) {
      this.probeAllowed = true;
      return false;
    }
    return true;
  }

  /**
   * Record a transient failure. May open or re-open the circuit.
   */
  recordFailure(service: ServiceName): void {
    const now = Date.now();
    // Evict failures outside the rolling window
    this.failures = this.failures.filter((t) => now - t < this.config.windowMs);
    this.failures.push(now);

    if (
      this.state === "closed" &&
      this.failures.length >= this.config.failureThreshold
    ) {
      this.state = "open";
      this.openedAt = now;
      warn(
        `Circuit breaker opened for ${service}: ${this.failures.length} failures in ${this.config.windowMs}ms window`,
      );
    } else if (this.state === "half-open") {
      this.state = "open";
      this.openedAt = now;
      this.probeAllowed = false;
      warn(`Circuit breaker re-opened for ${service}: probe failed`);
    }
  }

  /**
   * Record a successful call. Closes the circuit if it was half-open.
   */
  recordSuccess(service: ServiceName): void {
    if (this.state === "half-open") {
      this.state = "closed";
      this.failures = [];
      this.openedAt = null;
      this.probeAllowed = false;
      warn(`Circuit breaker closed for ${service}: probe succeeded`);
    }
  }

  reset(): void {
    this.state = "closed";
    this.failures = [];
    this.openedAt = null;
    this.probeAllowed = false;
  }
}

/**
 * Per-service circuit breaker registry. Tracks Linear and GitHub independently.
 */
export class CircuitBreakerRegistry {
  private readonly breakers: Record<ServiceName, ServiceCircuitBreaker>;

  constructor(config: BreakerConfig = DEFAULT_BREAKER_CONFIG) {
    this.breakers = {
      linear: new ServiceCircuitBreaker(config),
      github: new ServiceCircuitBreaker(config),
    };
  }

  getState(service: ServiceName): CircuitState {
    return this.breakers[service].getState();
  }

  isOpen(service: ServiceName): boolean {
    return this.breakers[service].isOpen();
  }

  recordFailure(service: ServiceName): void {
    this.breakers[service].recordFailure(service);
  }

  recordSuccess(service: ServiceName): void {
    this.breakers[service].recordSuccess(service);
  }

  getAllStates(): Record<ServiceName, CircuitState> {
    return {
      linear: this.getState("linear"),
      github: this.getState("github"),
    };
  }

  reset(service?: ServiceName): void {
    if (service) {
      this.breakers[service].reset();
    } else {
      for (const breaker of Object.values(this.breakers)) {
        breaker.reset();
      }
    }
  }
}

/** Global default registry used by withRetry(). */
export const defaultRegistry = new CircuitBreakerRegistry();

/**
 * Label prefixes that identify GitHub API calls.
 * All other withRetry() callers are treated as Linear.
 */
const GITHUB_LABEL_PREFIXES = [
  "getPR",
  "getChecks",
  "getRepo",
  "enableAutoMerge",
  "listReviews",
  "listReviewComments",
  "validateGitHub",
];

/**
 * Derive the service name from a withRetry() label.
 * Returns "github" for known GitHub call patterns; "linear" otherwise.
 */
export function inferService(label: string): ServiceName {
  for (const prefix of GITHUB_LABEL_PREFIXES) {
    if (
      label === prefix ||
      label.startsWith(`${prefix} `) ||
      label.startsWith(`${prefix}#`) ||
      label.startsWith(`${prefix}/`)
    ) {
      return "github";
    }
  }
  return "linear";
}
