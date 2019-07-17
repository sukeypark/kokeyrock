/*
 * Copyright 2019 -  Universidad Politécnica de Madrid.
 *
 * This file is part of Keyrock
 *
 */

const exec = require('child_process').exec;
const config = require('../../config');

// eslint-disable-next-line no-undef
before('Create and populate database', function(done) {
  // Mocha default timeout for tests is 2000 and to create database is needed more
  this.timeout(10000);

  return new Promise(function(resolve, reject) {
    const create_database =
      'mysql -u ' +
      config.database.username +
      ' -p' +
      config.database.password +
      " -e 'CREATE DATABASE IF NOT EXISTS idm_test;'";
    const load_data =
      'mysql -u ' +
      config.database.username +
      ' -p' +
      config.database.password +
      ' --default-character-set=utf8 idm_test < test/mysql-data/backup.sql';
    exec(create_database, function(error) {
      if (error) {
        process.exit();
        reject('Unable to create test database: ', error);
      } else {
        exec(load_data, function(error) {
          if (error) {
            process.exit();
            reject('Unable to load database: ', error);
          } else {
            // Run Keyrock
            require('../../bin/www');
            done();
            resolve('created');
          }
        });
      }
    });
  });
});

// eslint-disable-next-line no-undef
after('Delete database', function(done) {
  return new Promise(function(resolve, reject) {
    const load_data =
      'mysql -u ' +
      config.database.username +
      ' -p' +
      config.database.password +
      " -e 'DROP DATABASE idm_test;'";
    exec(load_data, function(error) {
      if (error) {
        process.exit();
        reject('Unable to load database: ', error);
      } else {
        resolve('deleted');
        done();
      }
    });
  });
});
