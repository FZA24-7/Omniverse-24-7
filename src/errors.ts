export class AppError extends Error {
  constructor(public statusCode: number, message: string, public code: string = 'error') {
    super(message);
  }
}
export const notFound = (what = 'Resource') => new AppError(404, `${what} not found`, 'not_found');
export const forbidden = (msg = 'You do not have permission to do this') => new AppError(403, msg, 'forbidden');
export const unauthorized = (msg = 'Authentication required') => new AppError(401, msg, 'unauthorized');
export const conflict = (msg: string) => new AppError(409, msg, 'conflict');
