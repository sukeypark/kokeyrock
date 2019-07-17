const models = require('../../models/models.js');
const create_oauth_response = require('../../models/model_oauth_server.js')
  .create_oauth_response;
const config_eidas = require('../../config.js').eidas;
const config_oauth2 = require('../../config.js').oauth2;
const user_controller = require('../../controllers/web/users');
const OauthServer = require('oauth2-server'); //eslint-disable-line snakecase/snakecase
const gravatar = require('gravatar');
const jsonwebtoken = require('jsonwebtoken');
const url = require('url');
const Request = OauthServer.Request;
const Response = OauthServer.Response;

const debug = require('debug')('idm:oauth_controller');

// Create Oauth Server model
const oauth_server = new OauthServer({
  model: require('../../models/model_oauth_server.js'),
  debug: true,
});

// POST /oauth2/token -- Function to handle token requests
exports.token = function(req, res) {
  debug(' --> token');

  const request = new Request(req);
  const response = new Response(res);

  oauth_server
    .token(request, response)
    .then(function(token) {
      if (token.scope.includes('jwt')) {
        response.body.token_type = 'jwt';
        delete response.body.expires_in;
      }
      res.status(200).json(response.body);
    })
    .catch(function(error) {
      debug('Error ', error);
      // Request is not authorized.
      return res.status(error.code || 500).json(error.message || error);
    });
};

// MW to see if query contains response_type attribute
exports.response_type_required = function(req, res, next) {
  debug(' --> response_type_required');

  if (
    req.query.response_type &&
    (req.query.response_type === 'code' || req.query.response_type === 'token')
  ) {
    next();
  } else {
    const text = 'Invalid response_type';
    req.session.message = { text, type: 'danger' };
    res.redirect('/auth/login');
  }
};

// MW to search application
exports.load_application = function(req, res, next) {
  debug(' --> load_application');

  models.oauth_client
    .findOne({
      where: { id: req.query.client_id },
      attributes: [
        'id',
        'name',
        'description',
        'image',
        'response_type',
        'redirect_uri',
      ],
    })
    .then(function(application) {
      if (application) {
        req.application = application;
        next();
      } else {
        const text =
          'Application with id = ' + req.query.client_id + ' doesn`t exist';
        req.session.message = { text, type: 'warning' };
        res.redirect('/auth/login');
      }
    })
    .catch(function(error) {
      debug('Error ', error);
      next(error);
    });
};

// MW to check user session
exports.check_user = function(req, res) {
  debug(' --> check_user');

  if (req.session.user) {
    check_user_authorized_application(req, res);
  } else {
    // Check if there are errors to be rendered
    const errors = req.session.errors || [];

    const render_values = {
      application: {
        url: '/oauth2' + req.url,
        name: req.application.name,
        description: req.application.description,
        response_type: req.query.response_type,
        id: req.query.client_id,
        state: req.query.state,
        redirect_uri: req.query.redirect_uri,
        image:
          req.application.image === 'default'
            ? '/img/logos/original/app.png'
            : '/img/applications/' + req.application.image,
      },
      errors,
      csrf_token: req.csrfToken(),
    };

    render_values.saml_request = {
      enabled: false,
    };

    if (config_eidas.enabled && req.sp) {
      render_values.saml_request.xml = req.saml_auth_request.xml;
      render_values.saml_request.postLocationUrl =
        req.saml_auth_request.postLocationUrl;
      render_values.saml_request.redirectLocationUrl =
        req.saml_auth_request.redirectLocationUrl;
      render_values.saml_request.enabled = true;
    }

    res.render('oauth/index', render_values);
  }
};

// POST /oauth2/authorize -- Function to handle authorization code and implicit requests
exports.authenticate_user = function(req, res) {
  debug(' --> authenticate_user');

  const errors = [];

  if (req.session.user) {
    check_user_authorized_application(req, res);
  } else {
    // See if inputs are empty
    if (!req.body.email) {
      errors.push({ message: 'email' });
    }
    if (!req.body.password) {
      errors.push({ message: 'password' });
    }

    // If not, authenticate and search if user is authorized in the application
    if (req.body.email && req.body.password) {
      user_controller.authenticate(req.body.email, req.body.password, function(
        error,
        user
      ) {
        if (error) {
          // If error, send message to the icoming path
          req.session.errors = [error.message ? error.message : ''];
          res.redirect('/oauth2' + req.url);
          return;
        }

        // Create req.session.user and save id and username
        // The session is defined by the existence of: req.session.user
        let image = '/img/logos/small/user.png';
        if (user.gravatar) {
          image = gravatar.url(
            user.email,
            { s: 25, r: 'g', d: 'mm' },
            { protocol: 'https' }
          );
        } else if (user.image !== 'default') {
          image = '/img/users/' + user.image;
        }
        req.session.user = {
          id: user.id,
          username: user.username,
          email: user.email,
          image,
          oauth_sign_in: true,
        };

        check_user_authorized_application(req, res);
      });
    } else {
      // Redirect to the same OAuth2 service login endpoint
      const name_errors = [];
      if (errors.length) {
        for (const i in errors) {
          name_errors.push(errors[i].message);
        }
      }
      req.session.errors = name_errors;
      res.redirect('/oauth2' + req.url);
    }
  }
};

// Check if user has authorized the application
function check_user_authorized_application(req, res) {
  debug(' --> check_user_authorized_application');

  if (config_oauth2.ask_authorization) {
    search_user_authorized_application(req.session.user.id, req.application.id)
      .then(function(user) {
        if (user) {
          req.user = user;
          oauth_authorize(req, res);
        } else {
          if (req.application.redirect_uri !== req.query.redirect_uri) {
            res.locals.message = {
              text: 'Mismatching redirect uri',
              type: 'warning',
            };
          }
          res.render('oauth/authorize', {
            application: {
              name: req.application.name,
              response_type: req.query.response_type,
              id: req.query.client_id,
              redirect_uri: req.query.redirect_uri,
              url: '/oauth2/enable_app?' + url.parse(req.url).query,
              state: req.query.state,
            },
            csrf_token: req.csrfToken(),
          });
        }
      })
      .catch(function(error) {
        debug('Error: ', error);
        req.session.errors = error;
        res.redirect('/');
      });
  } else {
    req.user = req.session.user;
    oauth_authorize(req, res);
  }
}

// Search user that has authorized the application
function search_user_authorized_application(user_id, app_id) {
  debug(' --> search_user_authorized_application');

  return models.user_authorized_application
    .findOne({
      where: { user_id, oauth_client_id: app_id },
      include: [
        {
          model: models.user,
          attributes: ['id', 'username', 'gravatar', 'image', 'email'],
        },
      ],
    })
    .then(function(user_is_authorized) {
      if (user_is_authorized) {
        return user_is_authorized.User;
      }
      return null;
    })
    .catch(function(error) {
      debug('Error ', error);
      Promise.reject('Internal error');
    });
}

// MW to load user
exports.load_user = function(req, res, next) {
  debug(' --> load_user');

  if (req.session.user.id) {
    models.user
      .findOne({
        where: { id: req.session.user.id },
      })
      .then(function(user) {
        req.user = user;
        next();
      })
      .catch(function(error) {
        debug('Error ', error);
        next(error);
      });
  } else {
    res.redirect('/');
  }
};

// POST /oauth2/enable_app -- User authorize the application to see their details
exports.enable_app = function(req, res) {
  debug(' --> enable_app');

  return oauth_authorize(req, res);
};

// Generate code or token
function oauth_authorize(req, res) {
  debug(' --> oauth_authorize');

  req.body.user = req.user;

  if (req.body.user.dataValues === undefined) {
    req.body.user.dataValues = {};
  }
  req.body.user.dataValues.type = 'user';

  const request = new Request(req);
  const response = new Response(res);

  return oauth_server
    .authorize(request, response)
    .then(function(success) {
      res.redirect(success);
    })
    .catch(function(error) {
      debug('Error: ', error);
      res.status(error.code || 500).json(error);
    });
}

// GET /user -- Function to handle token authentication
exports.authenticate_token = function(req, res) {
  debug(' --> authenticate_token');

  const action = req.query.action ? req.query.action : undefined;
  const resource = req.query.resource ? req.query.resource : undefined;
  const authzforce = req.query.authzforce ? req.query.authzforce : undefined;
  const req_app = req.query.app_id ? req.query.app_id : undefined;

  if ((action || resource) && authzforce) {
    const error = {
      message: 'Cannot handle 2 authentications levels at the same time',
      code: 400,
      title: 'Bad Request',
    };
    return res.status(400).json(error);
  }

  if (req_app) {
    return models.oauth_client
      .findById(req_app)
      .then(function(application) {
        if (application) {
          if (application.token_types.includes('jwt')) {
            return authenticate_jwt(
              req,
              res,
              action,
              resource,
              authzforce,
              req_app,
              application.jwt_secret
            );
          }
          return authenticate_bearer(
            req,
            res,
            action,
            resource,
            authzforce,
            req_app
          );
        }

        const message = {
          message: 'Unauthorized',
          code: 401,
          title: 'Unauthorized',
        };

        return res.status(401).json(message);
      })
      .catch(function(error) {
        debug('Error ', error);
        // Request is not authorized.
        return res.status(error.code || 500).json(error.message || error);
      });
  }

  return authenticate_bearer(req, res, action, resource, authzforce, req_app);
};

// Authenticate an incoming Json Web Token
function authenticate_jwt(
  req,
  res,
  action,
  resource,
  authzforce,
  req_app,
  jwt_secret
) {
  debug(' --> authenticate_jwt');

  jsonwebtoken.verify(req.query.access_token, jwt_secret, function(
    err,
    decoded
  ) {
    if (err) {
      debug('Error ' + err);
      authenticate_bearer(req, res, action, resource, authzforce, req_app);
    } else {
      const identity = {
        username: decoded.username,
        gravatar: decoded.isGravatarEnabled,
        email: decoded.email,
        id: decoded.id,
        type: decoded.type ? decoded.type : 'app',
      };

      const application_id = decoded.app_id;

      create_oauth_response(
        identity,
        application_id,
        action,
        resource,
        authzforce,
        req_app
      )
        .then(function(response) {
          return res.status(201).json(response);
        })
        .catch(function(error) {
          debug('Error ', error);
          // Request is not authorized.
          return res.status(error.code || 500).json(error.message || error);
        });
    }
  });
}

// Authenticate an incoming Bearer Token
function authenticate_bearer(req, res, action, resource, authzforce, req_app) {
  debug(' --> authenticate_bearer');

  const options = {
    allowBearerTokensInQueryString: true, // eslint-disable-line snakecase/snakecase
  };

  const request = new Request({
    headers: { authorization: req.headers.authorization },
    method: req.method,
    query: req.query,
    body: req.body,
  });

  const response = new Response(res);

  oauth_server
    .authenticate(request, response, options)
    .then(function(token_info) {
      const identity = token_info.user;
      const application_id = token_info.oauth_client.id;
      return create_oauth_response(
        identity,
        application_id,
        action,
        resource,
        authzforce,
        req_app
      );
    })
    .then(function(response) {
      return res.status(201).json(response);
    })
    .catch(function(error) {
      debug('Error ', error);
      // Request is not authorized.
      return res.status(error.code || 500).json(error.message || error);
    });
}

// POST /oauth2/revoke -- Function to revoke a token
exports.revoke_token = function(req, res) {
  debug(' --> revoke_token');

  const options = {};

  const request = new Request(req);
  const response = new Response(res);

  return oauth_server
    .revoke(request, response, options)
    .then(function() {
      debug('Success revoking a token');
      return res.status(200).json();
    })
    .catch(function(error) {
      debug('Error ', error);
      // Request is not authorized.
      return res.status(error.code || 500).json(error.message || error);
    });
};
