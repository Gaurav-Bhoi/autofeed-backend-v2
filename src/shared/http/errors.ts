import { HTTPException } from 'hono/http-exception'

export function badRequest(message: string) {
  return new HTTPException(400, { message })
}

export function unauthorized(message = 'Unauthorized') {
  return new HTTPException(401, { message })
}

export function forbidden(message = 'Forbidden') {
  return new HTTPException(403, { message })
}

export function badGateway(message: string) {
  return new HTTPException(502, { message })
}

export function serviceUnavailable(message: string) {
  return new HTTPException(503, { message })
}
