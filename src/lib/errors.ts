export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const notFound = (message = 'Nije pronađeno.') => new ApiError(404, 'not_found', message);
export const forbidden = (message = 'Nemate pristup.') => new ApiError(403, 'forbidden', message);
export const badRequest = (code: string, message: string) => new ApiError(400, code, message);
export const conflict = (code: string, message: string) => new ApiError(409, code, message);
