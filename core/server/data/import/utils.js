var Promise     = require('bluebird'),
    _           = require('lodash'),
    models      = require('../../models'),
    errors      = require('../../errors'),
    globalUtils = require('../../utils'),
    i18n        = require('../../i18n'),

    internalContext    = {context: {internal: true}},
    utils,
    areEmpty,
    updatedSettingKeys,
    stripProperties;

updatedSettingKeys = {
    activePlugins: 'active_apps',
    installedPlugins: 'installed_apps'
};

areEmpty = function (object) {
    var fields = _.toArray(arguments).slice(1),
        areEmpty = _.every(fields, function (field) {
            return _.isEmpty(object[field]);
        });

    return areEmpty;
};

stripProperties = function stripProperties(properties, data) {
    data = _.cloneDeep(data);
    _.each(data, function (obj) {
        _.each(properties, function (property) {
            delete obj[property];
        });
    });
    return data;
};

utils = {
    internal: internalContext,

    processUsers: function preProcessUsers(tableData, owner, existingUsers, objs) {
        // We need to:
        // 1. figure out who the owner of the blog is
        // 2. figure out what users we have
        // 3. figure out what users the import data refers to in foreign keys
        // 4. try to map each one to a user
        var userKeys = ['created_by', 'updated_by', 'published_by', 'author_id'],
            userMap = {};

        // Search the passed in objects for any user foreign keys
        _.each(objs, function (obj) {
            if (tableData[obj]) {
                // For each object in the tableData that matches
                _.each(tableData[obj], function (data) {
                    // For each possible user foreign key
                    _.each(userKeys, function (key) {
                        if (_.has(data, key) && data[key] !== null) {
                            userMap[data[key]] = {};
                        }
                    });
                });
            }
        });

        // We now have a list of users we need to figure out what their email addresses are
        // tableData.users has id's as numbers (see fixtures/export)
        // userIdToMap === tableData.users, but it's already a string, because it's an object key and they are always strings
        _.each(_.keys(userMap), function (userIdToMap) {
            var foundUser = _.find(tableData.users, function (tableDataUser) {
                return tableDataUser.id.toString() === userIdToMap;
            });

            // we now know that userToMap's email is foundUser.email - look them up in existing users
            if (foundUser && _.has(foundUser, 'email') && _.has(existingUsers, foundUser.email)) {
                existingUsers[foundUser.email].importId = userIdToMap;
                userMap[userIdToMap] = existingUsers[foundUser.email].realId;
            } else if (models.User.isOwnerUser(userIdToMap)) {
                existingUsers[owner.email].importId = userIdToMap;
                userMap[userIdToMap] = existingUsers[owner.email].realId;
            } else if (models.User.isExternalUser(userIdToMap)) {
                userMap[userIdToMap] = models.User.externalUser;
            } else {
                throw new errors.DataImportError({
                    message: i18n.t('errors.data.import.utils.dataLinkedToUnknownUser', {userToMap: userIdToMap}),
                    property: 'user.id',
                    value: userIdToMap
                });
            }
        });

        // now replace any user foreign keys
        _.each(objs, function (obj) {
            if (tableData[obj]) {
                // For each object in the tableData that matches
                _.each(tableData[obj], function (data) {
                    // For each possible user foreign key
                    _.each(userKeys, function (key) {
                        if (_.has(data, key) && data[key] !== null) {
                            data[key] = userMap[data[key]];
                        }
                    });
                });
            }
        });

        return tableData;
    },

    preProcessPostTags: function preProcessPostTags(tableData) {
        var postTags,
            postsWithTags = new Map();

        postTags = tableData.posts_tags;
        _.each(postTags, function (postTag) {
            if (!postsWithTags.get(postTag.post_id)) {
                postsWithTags.set(postTag.post_id, []);
            }
            postsWithTags.get(postTag.post_id).push(postTag.tag_id);
        });

        postsWithTags.forEach(function (tagIds, postId) {
            var post, tags;
            post = _.find(tableData.posts, function (post) {
                return post.id === postId;
            });

            if (post) {
                tags = _.filter(tableData.tags, function (tag) {
                    return _.indexOf(tagIds, tag.id) !== -1;
                });
                post.tags = [];
                _.each(tags, function (tag) {
                    // names are unique.. this should get the right tags added
                    // as long as tags are added first;
                    post.tags.push({name: tag.name});
                });
            }
        });

        return tableData;
    },

    preProcessRolesUsers: function preProcessRolesUsers(tableData, owner, roles) {
        var validRoles = _.map(roles, 'name');
        if (!tableData.roles || !tableData.roles.length) {
            tableData.roles = roles;
        }

        _.each(tableData.roles, function (_role) {
            var match = false;
            // Check import data does not contain unknown roles
            _.each(validRoles, function (validRole) {
                if (_role.name === validRole) {
                    match = true;
                    _role.oldId = _role.id;
                    _role.id = _.find(roles, {name: validRole}).id;
                }
            });
            // If unknown role is found then remove role to force down to Author
            if (!match) {
                _role.oldId = _role.id;
                _role.id = _.find(roles, {name: 'Author'}).id;
            }
        });

        _.each(tableData.roles_users, function (roleUser) {
            var user = _.find(tableData.users, function (user) {
                return user.id === roleUser.user_id;
            });

            // Map role_id to updated roles id
            roleUser.role_id = _.find(tableData.roles, {oldId: roleUser.role_id}).id;

            // Check for owner users that do not match current owner and change role to administrator
            if (roleUser.role_id === owner.roles[0].id && user && user.email && user.email !== owner.email) {
                roleUser.role_id = _.find(roles, {name: 'Administrator'}).id;
                user.roles = [roleUser.role_id];
            }

            // just the one role for now
            if (user && !user.roles) {
                user.roles = [roleUser.role_id];
            }
        });

        return tableData;
    },

    importTags: function importTags(tableData, transaction) {
        if (!tableData) {
            return Promise.resolve();
        }

        var ops = [];

        tableData = stripProperties(['id'], tableData);
        _.each(tableData, function (tag) {
            // Validate minimum tag fields
            if (areEmpty(tag, 'name', 'slug')) {
                return;
            }

            ops.push(models.Tag.findOne({name: tag.name}, {transacting: transaction}).then(function (_tag) {
                if (!_tag) {
                    return models.Tag.add(tag, _.extend({}, internalContext, {transacting: transaction}))
                        .catch(function (error) {
                            return Promise.reject({raw: error, model: 'tag', data: tag});
                        });
                }

                return _tag;
            }).reflect());
        });

        return Promise.all(ops);
    },

    importPosts: function importPosts(tableData, transaction) {
        if (!tableData) {
            return Promise.resolve();
        }

        var ops = [];

        tableData = stripProperties(['id'], tableData);
        _.each(tableData, function (post) {
            // Validate minimum post fields
            if (areEmpty(post, 'title', 'slug', 'markdown')) {
                return;
            }

            // The post importer has auto-timestamping disabled
            if (!post.created_at) {
                post.created_at = Date.now();
            }

            ops.push(models.Post.add(post, _.extend({}, internalContext, {transacting: transaction, importing: true}))
                    .catch(function (error) {
                        return Promise.reject({raw: error, model: 'post', data: post});
                    }).reflect()
            );
        });

        return Promise.all(ops);
    },

    importUsers: function importUsers(tableData, existingUsers, transaction) {
        var ops = [];
        tableData = stripProperties(['id'], tableData);
        _.each(tableData, function (user) {
            // Validate minimum user fields
            if (areEmpty(user, 'name', 'slug', 'email')) {
                return;
            }

            if (_.has(existingUsers, user.email)) {
                // User is already present, ignore
                return;
            }

            // Set password to a random password, and lock the account
            user.password = globalUtils.uid(50);
            user.status = 'locked';

            ops.push(models.User.add(user, _.extend({}, internalContext, {transacting: transaction}))
                .catch(function (error) {
                    return Promise.reject({raw: error, model: 'user', data: user});
                }));
        });

        return ops;
    },

    importSettings: function importSettings(tableData, transaction) {
        if (!tableData) {
            return Promise.resolve();
        }

        // for settings we need to update individual settings, and insert any missing ones
        // settings we MUST NOT update are 'core' and 'theme' settings
        // as all of these will cause side effects which don't make sense for an import
        var blackList = ['core', 'theme'],
            ops = [];

        tableData = stripProperties(['id'], tableData);
        tableData = _.filter(tableData, function (data) {
            return blackList.indexOf(data.type) === -1;
        });

        // Clean up legacy plugin setting references
        _.each(tableData, function (datum) {
            datum.key = updatedSettingKeys[datum.key] || datum.key;
        });

        ops.push(models.Settings.edit(tableData, _.extend({}, internalContext, {transacting: transaction})).catch(function (error) {
            // Ignore NotFound errors
            if (!(error instanceof errors.NotFoundError)) {
                return Promise.reject({raw: error, model: 'setting', data: tableData});
            }
        }).reflect());

        return Promise.all(ops);
    },

    importSubscribers: function importSubscribers(tableData, transaction) {
        if (!tableData) {
            return Promise.resolve();
        }

        var ops = [];
        tableData = stripProperties(['id'], tableData);

        _.each(tableData, function (subscriber) {
            ops.push(models.Subscriber.add(subscriber, _.extend({}, internalContext, {transacting: transaction}))
                .catch(function (error) {
                    // ignore duplicates
                    if (error.code && error.message.toLowerCase().indexOf('unique') === -1) {
                        return Promise.reject({
                            raw: error,
                            model: 'subscriber',
                            data: subscriber
                        });
                    }
                }).reflect());
        });

        return Promise.all(ops);
    },

    /** For later **/
    importApps: function importApps(tableData, transaction) {
        if (!tableData) {
            return Promise.resolve();
        }

        var ops = [];

        tableData = stripProperties(['id'], tableData);
        _.each(tableData, function (app) {
            // Avoid duplicates
            ops.push(models.App.findOne({name: app.name}, {transacting: transaction}).then(function (_app) {
                if (!_app) {
                    return models.App.add(app, _.extend({}, internalContext, {transacting: transaction}))
                        .catch(function (error) {
                            return Promise.reject({raw: error, model: 'app', data: app});
                        });
                }

                return _app;
            }).reflect());
        });

        return Promise.all(ops);
    }
};

module.exports = utils;
