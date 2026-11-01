'use strict';

const { ApiError } = require('./errors');

/** validate({ body, query, params }) using zod schemas. */
function validate(schemas) {
  return (req, _res, next) => {
    try {
      for (const part of ['body', 'query', 'params']) {
        if (!schemas[part]) continue;
        const result = schemas[part].safeParse(req[part]);
        if (!result.success) {
          const details = result.error.issues.map((issue) => ({
            field: issue.path.join('.') || part,
            message: issue.message,
          }));
          throw ApiError.badRequest('validation_error', 'Request payload failed validation', details);
        }
        req[part] = result.data;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { validate };
