import crypto from "node:crypto";

const COOKIE = "rs_session";
const scrypt = (pw: string, salt: Buffer): Buffer => crypto.scryptSync(pw, salt, 32);

/** Formato: scrypt$<salt hex>$<hash hex>. Se genera con `npm run hash-password`. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scrypt(password, salt).toString("hex")}`;
}

export function verifyHash(password: string, stored: string): boolean {
  const [kind, saltHex, hashHex] = stored.split("$");
  if (kind !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scrypt(password, Buffer.from(saltHex, "hex"));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest();

export interface AuthOptions {
  password?: string;
  passwordHash?: string;
  secret: string;
  secure: boolean;
  ttlMs?: number;
  maxFailures?: number;
  failureWindowMs?: number;
  now?: () => number;
}

export class Auth {
  private readonly ttlMs: number;
  private readonly failures = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(private readonly o: AuthOptions) {
    this.ttlMs = o.ttlMs ?? 12 * 60 * 60_000;
    this.now = o.now ?? Date.now;
  }

  get configured(): boolean {
    return Boolean(this.o.passwordHash || this.o.password) && this.o.secret.length > 0;
  }

  checkPassword(candidate: string): boolean {
    if (this.o.passwordHash) return verifyHash(candidate, this.o.passwordHash);
    if (!this.o.password) return false;
    return crypto.timingSafeEqual(sha(candidate), sha(this.o.password));
  }

  /** Limita los intentos fallidos por IP (5 cada 10 min por defecto). */
  allowAttempt(ip: string): boolean {
    const windowMs = this.o.failureWindowMs ?? 10 * 60_000;
    const recent = (this.failures.get(ip) ?? []).filter((t) => this.now() - t < windowMs);
    this.failures.set(ip, recent);
    return recent.length < (this.o.maxFailures ?? 5);
  }

  recordFailure(ip: string): void {
    this.failures.set(ip, [...(this.failures.get(ip) ?? []), this.now()]);
  }

  clearFailures(ip: string): void {
    this.failures.delete(ip);
  }

  private sign(exp: string): string {
    return crypto.createHmac("sha256", this.o.secret).update(exp).digest("base64url");
  }

  issueCookie(): string {
    const exp = String(this.now() + this.ttlMs);
    const value = `${exp}.${this.sign(exp)}`;
    return this.cookie(value, Math.floor(this.ttlMs / 1000));
  }

  clearCookie(): string {
    return this.cookie("", 0);
  }

  private cookie(value: string, maxAge: number): string {
    return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${this.o.secure ? "; Secure" : ""}`;
  }

  isAuthenticated(cookieHeader: string | undefined): boolean {
    if (!this.configured || !cookieHeader) return false;
    const raw = cookieHeader
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    if (!raw) return false;
    const [exp, sig] = raw.split(".");
    if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < this.now()) return false;
    const expected = Buffer.from(this.sign(exp));
    const given = Buffer.from(sig);
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  }
}
