// 401: the session is gone, go to /sign-in
export class SignedOut extends Error {
  constructor() { super('Signed out') }
}
