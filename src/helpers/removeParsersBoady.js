// helpers/removeParsersBoady.js

export function onlyWhen(predicate, mw) {
  return function (req, res, next) {
    try {
      if (predicate(req)) return mw(req, res, next);
      return next();
    } catch (e) {
      return next(e);
    }
  };
}

export function unless(predicate, mw) {
  return function (req, res, next) {
    try {
      if (!predicate(req)) return mw(req, res, next);
      return next();
    } catch (e) {
      return next(e);
    }
  };
}
