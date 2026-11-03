// 401: the session is gone, go to /sign-in
export class SignedOut extends Error {
  constructor() { super('Signed out') }
}

// 403 { error: 'step_up_required' }: the server wants a fresh passkey check
export class StepUpRequired extends Error {
  constructor() { super('Confirm with your passkey first.') }
}
