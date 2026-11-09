import { describe, expect, it } from "@effect/vitest";

import {
  type FormField,
  isPasswordOrigin,
  parsePasswordMessage,
  pickSignIn,
  planFill,
  savedFor,
  usernameFor,
} from "./passwordForms.ts";

/** One input as the page script describes it; `filled` follows `value` unless given. */
const field = (overrides: Partial<FormField>): FormField => ({
  type: "text",
  autocomplete: "",
  name: "",
  visible: true,
  editable: true,
  value: "",
  ...overrides,
  filled: overrides.filled ?? (overrides.value ?? "") !== "",
});
const email = (value = "", overrides: Partial<FormField> = {}) =>
  field({ type: "email", name: "email", value, ...overrides });
const password = (value = "", overrides: Partial<FormField> = {}) =>
  field({ type: "password", name: "password", value, ...overrides });

const ADA = { username: "ada@example.com", password: "hunter2" };
const GRACE = { username: "grace@example.com", password: "cobol" };

describe("pickSignIn", () => {
  it("takes the username and password a sign-in form submits", () => {
    expect(pickSignIn([email("ada@example.com"), password("hunter2")])).toEqual(ADA);
    // A plain text field before the password is the username; one after it is not.
    expect(
      pickSignIn([
        field({ name: "login", value: "ada" }),
        password("hunter2"),
        field({ name: "remember", value: "yes" }),
      ]),
    ).toEqual({ username: "ada", password: "hunter2" });
  });

  it("takes the new password of sign-up and change-password forms", () => {
    // A name is not a username, and the repeated password is the new one.
    expect(
      pickSignIn([
        field({ autocomplete: "name", value: "Ada Lovelace" }),
        email("ada@example.com"),
        password("n3w", { autocomplete: "new-password" }),
        password("n3w", { autocomplete: "new-password" }),
      ]),
    ).toEqual({ username: "ada@example.com", password: "n3w" });
    // Unmarked: the current password first, then the new one, typed twice.
    expect(pickSignIn([password("old"), password("n3w"), password("n3w")])?.password).toBe("n3w");
    expect(pickSignIn([password("old"), password("n3w")])?.password).toBe("n3w");
    // Marked fields say which is which, in any order.
    expect(
      pickSignIn([
        password("n3w", { autocomplete: "new-password" }),
        password("old", { autocomplete: "current-password" }),
      ])?.password,
    ).toBe("n3w");
    // Three different ones: no telling which is new.
    expect(pickSignIn([password("a"), password("b"), password("c")])).toBeNull();
  });

  it("reads a username step, and a password step without a username", () => {
    expect(pickSignIn([email("ada@example.com")])).toEqual({
      username: "ada@example.com",
      password: undefined,
    });
    expect(pickSignIn([password("hunter2")])).toEqual({ username: undefined, password: "hunter2" });
    // A password step that keeps the username in a hidden field for password managers.
    expect(
      pickSignIn([
        field({ autocomplete: "username", visible: false, value: "ada@example.com" }),
        password("hunter2"),
      ]),
    ).toEqual(ADA);
  });

  it("ignores forms that hold no sign-in", () => {
    expect(pickSignIn([field({ name: "q", value: "pizza near me" })])).toBeNull();
    expect(pickSignIn([email(), password()])).toBeNull();
    // One-time codes and card numbers hide what is typed but are not passwords.
    expect(
      pickSignIn([password("123456", { autocomplete: "one-time-code", name: "otp" })]),
    ).toBeNull();
    expect(pickSignIn([password("4242", { autocomplete: "cc-number", name: "card" })])).toBeNull();
  });
});

describe("planFill", () => {
  it("fills an empty login form with the first saved sign-in", () => {
    expect(planFill([email(), password()], [ADA, GRACE])).toEqual([
      { index: 0, value: ADA.username },
      { index: 1, value: ADA.password },
    ]);
    // A password step alone gets the password.
    expect(planFill([password()], [GRACE])).toEqual([{ index: 0, value: GRACE.password }]);
  });

  it("follows a username the form already holds, and keeps what is already filled", () => {
    expect(planFill([email(GRACE.username), password()], [ADA, GRACE])).toEqual([
      { index: 1, value: GRACE.password },
    ]);
    expect(planFill([email("someone@else.example"), password()], [ADA])).toEqual([]);
    // A hidden username field says whose password step it is.
    expect(
      planFill(
        [field({ autocomplete: "username", visible: false, value: GRACE.username }), password()],
        [ADA, GRACE],
      ),
    ).toEqual([{ index: 1, value: GRACE.password }]);
    expect(planFill([email(), password("", { filled: true })], [ADA])).toEqual([
      { index: 0, value: ADA.username },
    ]);
  });

  it("leaves sign-up and change-password forms alone, but for a current password field", () => {
    expect(
      planFill(
        [
          email(),
          password("", { autocomplete: "new-password" }),
          password("", { autocomplete: "new-password" }),
        ],
        [ADA],
      ),
    ).toEqual([]);
    expect(planFill([password(), password()], [ADA])).toEqual([]);
    expect(
      planFill(
        [
          password("", { autocomplete: "current-password" }),
          password("", { autocomplete: "new-password" }),
        ],
        [ADA],
      ),
    ).toEqual([{ index: 0, value: ADA.password }]);
  });

  it("fills a username step only into a field marked for the username", () => {
    expect(planFill([field({ autocomplete: "username" })], [ADA])).toEqual([
      { index: 0, value: ADA.username },
    ]);
    expect(planFill([email()], [ADA])).toEqual([]);
  });

  it("fills only fields someone can see and type in", () => {
    expect(
      planFill([email("", { editable: false }), password("", { visible: false })], [ADA]),
    ).toEqual([]);
    expect(planFill([email(), password()], [])).toEqual([]);
    // A site that asked for a password only has no username to fill.
    expect(planFill([email(), password()], [{ username: "", password: "pin" }])).toEqual([
      { index: 1, value: "pin" },
    ]);
  });
});

describe("saved sign-ins", () => {
  const saved = [
    { origin: "https://github.com", ...ADA, lastUsedAt: "2026-10-01T00:00:00.000Z" },
    { origin: "https://github.com", ...GRACE, lastUsedAt: "2026-10-20T00:00:00.000Z" },
    { origin: "https://gist.github.com", ...ADA, lastUsedAt: "2026-10-24T00:00:00.000Z" },
  ];

  it("offers an origin's own, the username its username step named first, then the latest", () => {
    const usernames = (named?: string) =>
      savedFor(saved, "https://github.com", named).map((entry) => entry.username);
    expect(usernames()).toEqual([GRACE.username, ADA.username]);
    expect(usernames(ADA.username)).toEqual([ADA.username, GRACE.username]);
    expect(savedFor(saved, "https://example.com", undefined)).toEqual([]);
  });

  it("saves a form without a username under the account it most likely is", () => {
    expect(usernameFor("anything", "named@example.com", [ADA, GRACE])).toBe("named@example.com");
    // A site's prompt to confirm the password, in a tab that never signed in.
    expect(usernameFor(GRACE.password, undefined, [ADA, GRACE])).toBe(GRACE.username);
    expect(usernameFor("n3w", undefined, [ADA])).toBe(ADA.username);
    expect(usernameFor("n3w", undefined, [ADA, GRACE])).toBe("");
    expect(usernameFor("n3w", undefined, [])).toBe("");
  });
});

describe("page messages", () => {
  it("keeps passwords to http and https sites", () => {
    for (const origin of ["https://github.com", "http://localhost:5173", "http://192.168.1.1"]) {
      expect(isPasswordOrigin(origin)).toBe(true);
    }
    // As DevTools reports opaque origins (sandboxed or data: pages), and other schemes.
    for (const origin of [
      "",
      "://",
      "null",
      "file://",
      "chrome-extension://abc",
      "https://a.example/path",
    ]) {
      expect(isPasswordOrigin(origin)).toBe(false);
    }
  });

  it("reads what the page script sends and drops anything else", () => {
    const fields = [email("ada@example.com"), password("hunter2")];
    expect(parsePasswordMessage(JSON.stringify({ kind: "submit", fields }))).toEqual({
      kind: "submit",
      fields,
    });
    expect(parsePasswordMessage(JSON.stringify({ kind: "fill", id: 3, fields }))).toEqual({
      kind: "fill",
      id: 3,
      fields,
    });
    for (const payload of [
      "not json",
      JSON.stringify({ kind: "steal", fields }),
      JSON.stringify({ kind: "fill", id: 0, fields }),
      JSON.stringify({ kind: "submit", fields: [{ ...fields[0], value: "x".repeat(1_025) }] }),
      JSON.stringify({ kind: "submit", fields: Array.from({ length: 41 }, () => fields[0]) }),
    ]) {
      expect(parsePasswordMessage(payload)).toBeNull();
    }
  });
});
