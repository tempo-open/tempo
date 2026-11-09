/**
 * The page half of saved passwords: the script each tab runs in an isolated world, its messages,
 * and what the server decides from them. Page script cannot see that world, so it can neither
 * call the binding nor change what the script reads, though its own fields can hold anything.
 * The server takes each message's origin from the browser and saves and fills only for it.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The isolated world the page script runs in, the only one that has the binding. */
export const PASSWORD_WORLD = "tempo-passwords";
/** The binding the page script reports submissions and fill requests over. */
export const PASSWORD_BINDING = "__tempoPasswordMessage";
/** The page script's function the server calls with what to fill. */
const PASSWORD_FILL = "__tempoPasswordFill";
/** The page script's function that empties what the tab filled. */
const PASSWORD_CLEAR = "__tempoPasswordClear";

/** No one types a longer username or password; a message holding one is dropped. */
const MAX_VALUE_LENGTH = 1_024;
const MAX_FIELDS = 40;
/** Fill requests the page keeps for an answer; most get none, as most sites have no saved password. */
const MAX_PENDING_FILLS = 16;

const FormField = Schema.Struct({
  /** `password` for a field that ever was one: a show-password toggle makes it text. */
  type: Schema.String.check(Schema.isMaxLength(64)),
  /** The autocomplete attribute, lower case. */
  autocomplete: Schema.String.check(Schema.isMaxLength(256)),
  /** Its name and id, lower case. */
  name: Schema.String.check(Schema.isMaxLength(512)),
  visible: Schema.Boolean,
  editable: Schema.Boolean,
  filled: Schema.Boolean,
  /** What it holds. Fill requests leave out password fields' values. */
  value: Schema.String.check(Schema.isMaxLength(MAX_VALUE_LENGTH)),
});
/** One input of a form, in document order. */
export type FormField = typeof FormField.Type;

const Fields = Schema.Array(FormField).check(Schema.isMaxLength(MAX_FIELDS));

const PasswordPageMessage = Schema.Union([
  /** A form was submitted: by a submit event, a click on one of its buttons, or Enter in a field. */
  Schema.Struct({ kind: Schema.Literal("submit"), fields: Fields }),
  /** A login form appeared; `id` names it in the answer. */
  Schema.Struct({
    kind: Schema.Literal("fill"),
    id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    fields: Fields,
  }),
]);
export type PasswordPageMessage = typeof PasswordPageMessage.Type;

const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(PasswordPageMessage));

/** Reads one binding payload; anything else is dropped. */
export const parsePasswordMessage = (payload: string): PasswordPageMessage | null =>
  // The page cannot make the server parse more than the largest message it can send.
  payload.length > MAX_FIELDS * (MAX_VALUE_LENGTH + 1_024)
    ? null
    : Option.getOrNull(decodeMessage(payload));

/** Origins passwords are saved on: http and https sites, never an opaque or extension one. */
export const isPasswordOrigin = (origin: string) => {
  if (!URL.canParse(origin)) return false;
  const url = new URL(origin);
  return (url.protocol === "https:" || url.protocol === "http:") && url.origin === origin;
};

const tokens = (field: FormField) => field.autocomplete.split(/\s+/u);
const hasToken = (field: FormField, token: string) => tokens(field).includes(token);

/** Fields that are not passwords even when they hide what is typed: codes and card numbers. */
const isCode = (token: string) => token === "one-time-code" || token.startsWith("cc-");
const isPassword = (field: FormField) => field.type === "password" && !tokens(field).some(isCode);

/** Autocomplete tokens that mark a text field as something other than a username. */
const NOT_USERNAME = new Set([
  "name",
  "given-name",
  "additional-name",
  "family-name",
  "nickname",
  "organization",
  "street-address",
  "address-line1",
  "address-line2",
  "postal-code",
  "country",
  "country-name",
  "bday",
  "url",
]);
const TEXT_TYPES = new Set(["text", "email", "tel"]);
const isTextField = (field: FormField) =>
  TEXT_TYPES.has(field.type) &&
  !tokens(field).some((token) => isCode(token) || NOT_USERNAME.has(token));
const isEmail = (field: FormField) => field.type === "email" || hasToken(field, "email");

/**
 * The field holding the username: one marked `autocomplete="username"`
 * (hidden ones too, as sites put on a password step), else the last email,
 * else the last text field before the first password field. Only fields
 * `usable` says may count.
 */
const usernameIndex = (fields: ReadonlyArray<FormField>, usable: (field: FormField) => boolean) => {
  const marked = fields.findIndex((field) => hasToken(field, "username") && usable(field));
  if (marked !== -1) return marked;
  const firstPassword = fields.findIndex(isPassword);
  const before = (firstPassword === -1 ? fields : fields.slice(0, firstPassword))
    .map((field, index) => ({ field, index }))
    .filter(({ field }) => field.visible && isTextField(field) && usable(field));
  return (before.findLast(({ field }) => isEmail(field)) ?? before.at(-1))?.index ?? -1;
};

const USERNAME_NAME = /user|login|e-?mail|account|ident|phone/u;
/** A lone field a username step may have asked for, unlike a search box. */
const looksLikeUsername = (field: FormField) =>
  hasToken(field, "username") || isEmail(field) || USERNAME_NAME.test(field.name);

/**
 * The password a form sets: sign-in forms have one, sign-up forms repeat the new one, and
 * change-password forms put the current one first. `new-password` marks the new one,
 * `current-password` one that is not. Unmarked, of two different ones the second is new, and
 * among three or more the new one is the one typed twice.
 */
const newPassword = (passwords: ReadonlyArray<FormField>): string | undefined => {
  const marked = passwords.find((field) => hasToken(field, "new-password"));
  if (marked !== undefined) return marked.value;
  const unmarked = passwords.filter((field) => !hasToken(field, "current-password"));
  const values = (unmarked.length === 0 ? passwords : unmarked).map((field) => field.value);
  if (values.length <= 2) return values.at(-1);
  return values.find((value, index) => values.indexOf(value) !== index);
};

export type SubmittedSignIn =
  /** The username step of a username-first sign-in. */
  | { readonly username: string; readonly password: undefined }
  /** No username on a password step, or on a site's prompt to confirm the password. */
  | { readonly username: string | undefined; readonly password: string };

/** What a submitted form signs in, signs up or changes the password with, if anything. */
export const pickSignIn = (fields: ReadonlyArray<FormField>): SubmittedSignIn | null => {
  const typed = fields.filter((field) => isPassword(field) && field.value !== "");
  const shown = typed.filter((field) => field.visible);
  const index = usernameIndex(fields, (field) => field.value !== "");
  const user = index === -1 ? undefined : fields[index]!;
  if (typed.length === 0) {
    return user !== undefined && looksLikeUsername(user)
      ? { username: user.value, password: undefined }
      : null;
  }
  const password = newPassword(shown.length > 0 ? shown : typed);
  return password === undefined ? null : { username: user?.value, password };
};

/**
 * The username a form without one saves its password under: the one the
 * tab's last username step on the site named, else the site's saved account
 * with that password, else its only saved account, else none.
 */
export const usernameFor = (
  password: string,
  named: string | undefined,
  site: ReadonlyArray<SavedSignIn>,
) =>
  named ??
  site.find((entry) => entry.password === password)?.username ??
  (site.length === 1 ? site[0]!.username : "");

export interface SavedSignIn {
  readonly username: string;
  readonly password: string;
}

export interface FillValue {
  /** The field's place in the request's fields. */
  readonly index: number;
  readonly value: string;
}

/**
 * What to fill in a form that appeared: the saved sign-in it fits, in fields nobody filled yet.
 * A username the form already holds picks the sign-in, else the first of `saved`. Sign-up forms,
 * and change-password forms without a field marked for the current password, get nothing. A
 * username step gets its username only into a field marked for it.
 */
export const planFill = (
  fields: ReadonlyArray<FormField>,
  saved: ReadonlyArray<SavedSignIn>,
): ReadonlyArray<FillValue> => {
  const passwordIndexes = fields.flatMap((field, index) =>
    isPassword(field) && field.visible ? [index] : [],
  );
  const setsPassword = fields.some((field) => isPassword(field) && hasToken(field, "new-password"));
  let passwordIndex: number | undefined;
  if (passwordIndexes.length > 0) {
    const current = passwordIndexes.filter((index) => hasToken(fields[index]!, "current-password"));
    passwordIndex =
      setsPassword || passwordIndexes.length > 1
        ? current.length === 1
          ? current[0]
          : undefined
        : passwordIndexes[0];
    if (passwordIndex === undefined) return [];
  }
  const userIndex = usernameIndex(fields, (field) => field.visible || field.filled);
  const user = userIndex === -1 ? undefined : fields[userIndex]!;
  if (passwordIndex === undefined && (user === undefined || !hasToken(user, "username"))) return [];
  const signIn =
    user?.filled === true ? saved.find((candidate) => candidate.username === user.value) : saved[0];
  if (signIn === undefined) return [];
  const values: Array<FillValue> = [];
  if (user !== undefined && !user.filled && user.visible && user.editable && signIn.username) {
    values.push({ index: userIndex, value: signIn.username });
  }
  const password = passwordIndex === undefined ? undefined : fields[passwordIndex]!;
  if (password !== undefined && !password.filled && password.editable) {
    values.push({ index: passwordIndex!, value: signIn.password });
  }
  return values;
};

/** An origin's saved sign-ins, the username its username step named first, then the most recently used. */
export const savedFor = <
  S extends SavedSignIn & { readonly origin: string; readonly lastUsedAt: string },
>(
  saved: ReadonlyArray<S>,
  origin: string,
  named: string | undefined,
): ReadonlyArray<S> =>
  saved
    .filter((entry) => entry.origin === origin)
    .toSorted(
      (a, b) =>
        Number(b.username === named) - Number(a.username === named) ||
        b.lastUsedAt.localeCompare(a.lastUsedAt),
    );

/** Fills one request in the context that sent it. */
export const fillExpression = (id: number, values: ReadonlyArray<FillValue>) =>
  `globalThis.${PASSWORD_FILL}(${id}, ${JSON.stringify(values)})`;

export const CLEAR_EXPRESSION = `globalThis.${PASSWORD_CLEAR}()`;

/**
 * Watches a page's forms from the isolated world. A submit, a button click or Enter reports the
 * fields that belong together: a form's own, or on a page without forms, those near the button or
 * field. Password and username fields ask for a fill once shown, even ones added later. Fills fire
 * input and change events as typing would; only a person's or agent's input counts (`isTrusted`).
 */
export const passwordPageScript = (): string => `(() => {
  const send = globalThis[${JSON.stringify(PASSWORD_BINDING)}];
  // A desktop tab keeps the script of each connection that served it; the first one runs.
  if (typeof send !== "function" || ${JSON.stringify(PASSWORD_FILL)} in globalThis) return;
  const stringify = JSON.stringify;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  const FIELD_TYPES = new Set(["text", "email", "tel", "password"]);
  const BUTTONS = "button, input[type=submit], input[type=image], input[type=button], [role=button]";
  const WANTS_FILL = 'input[type=password i], input[autocomplete~="username" i]';
  const secret = new WeakSet();
  const offered = new WeakSet();
  const requests = new Map();
  let filled = [];
  let nextId = 0;
  let lastSubmitted = "";

  const isField = (node) => {
    if (!(node instanceof HTMLInputElement)) return false;
    if (node.type === "password") secret.add(node);
    return secret.has(node) || FIELD_TYPES.has(node.type);
  };
  const visible = (input) => input.getClientRects().length > 0 && getComputedStyle(input).visibility !== "hidden";
  const scopeOf = (element) => {
    const form = element.form ?? element.closest("form");
    if (form) return [...form.elements].filter(isField);
    let nearest = null;
    for (let node = element.parentElement, depth = 0; node && depth < 10; node = node.parentElement, depth++) {
      const fields = [...node.querySelectorAll("input")].filter((input) => input.form === null && isField(input));
      if (fields.some((input) => secret.has(input))) return fields;
      if (nearest === null && fields.length > 0) nearest = fields;
    }
    return nearest ?? (isField(element) ? [element] : []);
  };
  const describe = (fields, withSecrets) => fields.slice(0, ${MAX_FIELDS}).map((input) => {
    const isSecret = secret.has(input);
    return {
      type: isSecret ? "password" : input.type,
      autocomplete: (input.getAttribute("autocomplete") ?? "").toLowerCase().slice(0, 256),
      name: (input.name + " " + input.id).toLowerCase().slice(0, 512),
      visible: visible(input),
      editable: !input.disabled && !input.readOnly,
      filled: input.value !== "",
      value: isSecret && !withSecrets ? "" : input.value,
    };
  });

  const submitted = (element) => {
    const fields = describe(scopeOf(element), true);
    if (fields.length === 0 || fields.some((field) => field.value.length > ${MAX_VALUE_LENGTH})) return;
    // A click on a form's button and the submit event after it report the same values.
    const key = stringify(fields.map((field) => field.value));
    if (key === lastSubmitted) return;
    lastSubmitted = key;
    send(stringify({ kind: "submit", fields }));
  };
  const targetOf = (event) => event.composedPath()[0];
  addEventListener("submit", (event) => {
    if (event.isTrusted && event.target instanceof HTMLFormElement) submitted(event.target);
  }, true);
  addEventListener("click", (event) => {
    const target = targetOf(event);
    const button = event.isTrusted && target instanceof Element ? target.closest(BUTTONS) : null;
    if (button) submitted(button);
  }, true);
  addEventListener("keydown", (event) => {
    if (event.isTrusted && event.key === "Enter" && !event.isComposing && isField(targetOf(event)))
      submitted(targetOf(event));
  }, true);

  const typeInto = (input, value) => {
    setValue.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText" }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  Object.defineProperty(globalThis, ${JSON.stringify(PASSWORD_FILL)}, {
    value: (id, values) => {
      const fields = requests.get(id);
      requests.delete(id);
      if (fields === undefined) return;
      for (const { index, value } of values) {
        const input = fields[index];
        // What a person typed meanwhile stays.
        if (input === undefined || !input.isConnected || input.value !== "") continue;
        typeInto(input, value);
        // Someone in the field may be about to type: their keys replace the fill, not follow it.
        if (input === document.activeElement) input.select();
        filled.push({ input, value });
      }
    },
  });
  Object.defineProperty(globalThis, ${JSON.stringify(PASSWORD_CLEAR)}, {
    value: () => {
      for (const { input, value } of filled) if (input.isConnected && input.value === value) typeInto(input, "");
      filled = [];
    },
  });

  const offer = (input) => {
    if (offered.has(input) || !visible(input)) return;
    const fields = scopeOf(input);
    for (const field of fields) offered.add(field);
    const id = ++nextId;
    requests.set(id, fields);
    if (requests.size > ${MAX_PENDING_FILLS}) requests.delete(requests.keys().next().value);
    send(stringify({ kind: "fill", id, fields: describe(fields, false).map((field) => ({ ...field, value: field.value.slice(0, ${MAX_VALUE_LENGTH}) })) }));
  };
  let scheduled = false;
  const scan = () => {
    scheduled = false;
    for (const input of document.querySelectorAll(WANTS_FILL)) if (isField(input)) offer(input);
  };
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(scan, 100);
  }).observe(document, { childList: true, subtree: true });
  // A field that was hidden when its form appeared asks once someone moves into it.
  addEventListener("focusin", (event) => {
    const target = targetOf(event);
    if (target instanceof Element && target.matches(WANTS_FILL) && isField(target)) offer(target);
  }, true);
  scan();
})();`;
