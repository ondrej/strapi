/**
 * Entity validator
 * Module that will validate input data for entity creation or edition
 */
'use strict';

const _ = require('lodash');
const fp = require('lodash/fp');
const { yup, formatYupErrors, contentTypes: contentTypesUtils } = require('strapi-utils');
const validators = require('./validators');

const mapValuesWithKey = fp.mapValues.convert({ cap: false });
const pickByWithKey = fp.pickBy.convert({ cap: false });

const isMedia = attr => (attr.collection || attr.model) === 'file' && attr.plugin === 'upload';

const isSimpleAttribute = attr =>
  !attr.collection && !attr.model && attr.type !== 'component' && attr.type !== 'dynamiczone';

const addMinMax = (attr, validator, data) => {
  if (Number.isInteger(attr.min) && (attr.required || (Array.isArray(data) && data.length > 0))) {
    validator = validator.min(attr.min);
  }
  if (Number.isInteger(attr.max)) {
    validator = validator.max(attr.max);
  }
  return validator;
};

const addRequiredValidation = createOrUpdate => (required, validator) => {
  if (required) {
    if (createOrUpdate === 'creation') {
      validator = validator.notNil();
    } else if (createOrUpdate === 'update') {
      validator = validator.notNull();
    }
  } else {
    validator = validator.nullable();
  }
  return validator;
};

const addDefault = createOrUpdate => (attr, validator) => {
  if (createOrUpdate === 'creation') {
    if (
      ((attr.type === 'component' && attr.repeatable) || attr.type === 'dynamiczone') &&
      !attr.required
    ) {
      validator = validator.default([]);
    } else {
      validator = validator.default(attr.default);
    }
  } else {
    validator = validator.default(undefined);
  }

  return validator;
};

const preventCast = validator => validator.transform((val, originalVal) => originalVal);

const createComponentValidator = createOrUpdate => (attr, data, { isDraft }) => {
  let validator;

  const [model] = strapi.db.getModelsByAttribute(attr);
  if (!model) {
    throw new Error('Validation failed: Model not found');
  }

  if (_.get(attr, 'repeatable', false) === true) {
    validator = yup
      .array()
      .of(
        yup.lazy(item => createModelValidator(createOrUpdate)(model, item, { isDraft }).notNull())
      );
    validator = addRequiredValidation(createOrUpdate)(true, validator);
    validator = addMinMax(attr, validator, data);
  } else {
    validator = createModelValidator(createOrUpdate)(model, data, { isDraft });
    validator = addRequiredValidation(createOrUpdate)(!isDraft && attr.required, validator);
  }

  return validator;
};

const createDzValidator = createOrUpdate => (attr, data, { isDraft }) => {
  let validator;

  validator = yup.array().of(
    yup.lazy(item => {
      const model = strapi.getModel(_.get(item, '__component'));
      const schema = yup
        .object()
        .shape({
          __component: yup
            .string()
            .required()
            .oneOf(_.keys(strapi.components)),
        })
        .notNull();

      return model
        ? schema.concat(createModelValidator(createOrUpdate)(model, item, { isDraft }))
        : schema;
    })
  );
  validator = addRequiredValidation(createOrUpdate)(true, validator);
  validator = addMinMax(attr, validator, data);

  return validator;
};

const createRelationValidator = createOrUpdate => (attr, data, { isDraft }) => {
  let validator;

  if (Array.isArray(data)) {
    validator = yup.array().of(yup.mixed());
  } else {
    validator = yup.mixed();
  }
  validator = addRequiredValidation(createOrUpdate)(!isDraft && attr.required, validator);

  return validator;
};

const createSimpleAttributeValidator = createOrUpdate => (attr, { isDraft }) => {
  let validator;

  if (attr.type in validators) {
    validator = validators[attr.type](attr, { isDraft });
  } else {
    // No validators specified - fall back to mixed
    validator = yup.mixed();
  }

  validator = addRequiredValidation(createOrUpdate)(!isDraft && attr.required, validator);

  return validator;
};

const createAttributeValidator = createOrUpdate => (attr, data, { isDraft }) => {
  let validator;
  if (isMedia(attr)) {
    validator = yup.mixed();
  } else if (isSimpleAttribute(attr)) {
    validator = createSimpleAttributeValidator(createOrUpdate)(attr, { isDraft });
  } else {
    if (attr.type === 'component') {
      validator = createComponentValidator(createOrUpdate)(attr, data, { isDraft });
    } else if (attr.type === 'dynamiczone') {
      validator = createDzValidator(createOrUpdate)(attr, data, { isDraft });
    } else {
      validator = createRelationValidator(createOrUpdate)(attr, data, { isDraft });
    }

    validator = preventCast(validator);
  }

  validator = addDefault(createOrUpdate)(attr, validator);

  return validator;
};

const createModelValidator = createOrUpdate => (model, data, { isDraft }) => {
  const nonWritableAttributes = model ? contentTypesUtils.getNonWritableAttributes(model) : [];

  return yup.object().shape(
    _.flow(
      fp.getOr({}, 'attributes'),
      pickByWithKey((attr, attrName) => !nonWritableAttributes.includes(attrName)),
      mapValuesWithKey((attr, attrName) =>
        createAttributeValidator(createOrUpdate)(attr, _.get(data, attrName), { isDraft })
      )
    )(model)
  );
};

const createValidateEntity = createOrUpdate => async (model, data, { isDraft = false } = {}) => {
  try {
    const validator = createModelValidator(createOrUpdate)(model, data, { isDraft }).required();
    return await validator.validate(data, { abortEarly: false });
  } catch (e) {
    throw strapi.errors.badRequest('ValidationError', { errors: formatYupErrors(e) });
  }
};

module.exports = {
  validateEntityCreation: createValidateEntity('creation'),
  validateEntityUpdate: createValidateEntity('update'),
};
