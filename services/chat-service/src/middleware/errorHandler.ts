import { Request, Response, NextFunction } from 'express';
import { formatErrorResponse } from '@wapi/contracts';

export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) {
    return next(err);
  }

  const formatted = formatErrorResponse(err);

  console.error("[Error Handler]", req.method, String(req.path), err);

  res.status(formatted.error.statusCode).json(formatted);
}
