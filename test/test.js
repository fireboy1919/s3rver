"use strict";

const async = require("async");
const AWS = require("aws-sdk");
const { expect } = require("chai");
const fs = require("fs-extra");
const { find, times } = require("lodash");
const md5 = require("md5");
const moment = require("moment");
const os = require("os");
const path = require("path");
const request = require("request");
const util = require("util");

const S3rver = require("..");

const tmpDir = path.join(os.tmpdir(), "s3rver_test");
S3rver.defaultOptions.directory = tmpDir;

/**
 * Remove if exists and recreate the temporary directory
 *
 * Be aware of https://github.com/isaacs/rimraf/issues/25
 * Buckets can fail to delete on Windows likely due to a bug/shortcoming in Node.js
 */
function resetTmpDir() {
  try {
    fs.removeSync(tmpDir);
    // eslint-disable-next-line no-empty
  } catch (err) {}
  fs.ensureDirSync(tmpDir);
}

function generateTestObjects(s3Client, bucket, amount, callback) {
  const testObjects = times(amount, i => ({
    Bucket: bucket,
    Key: "key" + i,
    Body: "Hello!"
  }));
  async.eachSeries(
    testObjects,
    (testObject, callback) => {
      s3Client.putObject(testObject, callback);
    },
    callback
  );
}

describe("S3rver Tests", function() {
  const buckets = [
    "bucket1",
    "bucket2",
    "bucket3",
    "bucket4",
    "bucket5",
    "bucket6"
  ];
  let s3rver;
  let s3Client;

  beforeEach("Reset buckets", resetTmpDir);
  beforeEach("Start s3rver and create buckets", function(done) {
    s3rver = new S3rver({
      port: 4569,
      hostname: "localhost",
      silent: true
    }).run((err, hostname, port) => {
      if (err) return done("Error starting server", err);

      s3Client = new AWS.S3({
        accessKeyId: "123",
        secretAccessKey: "abc",
        endpoint: util.format("http://%s:%d", hostname, port),
        sslEnabled: false,
        s3ForcePathStyle: true
      });
      // Create 6 buckets
      async.eachSeries(
        buckets,
        (bucket, callback) => {
          s3Client.createBucket({ Bucket: bucket }, err => {
            if (err && err.code !== "BucketAlreadyExists") {
              return callback(err);
            }
            callback();
          });
        },
        done
      );
    });
  });

  afterEach("Close s3rver", function(done) {
    s3rver.close(done);
  });

  it("should fetch fetch six buckets", function(done) {
    s3Client.listBuckets((err, buckets) => {
      if (err) return done(err);
      expect(buckets.Buckets).to.have.lengthOf(6);
      for (const bucket of buckets.Buckets) {
        expect(bucket.Name).to.exist;
        expect(moment(bucket.CreationDate).isValid()).to.be.true;
      }
      done();
    });
  });

  it("should create a bucket with valid domain-style name", function(done) {
    s3Client.createBucket({ Bucket: "a-test.example.com" }, done);
  });

  it("should fail to create a bucket because of invalid name", function(done) {
    s3Client.createBucket({ Bucket: "-$%!nvalid" }, err => {
      expect(err).to.exist;
      expect(err.statusCode).to.equal(400);
      expect(err.code).to.equal("InvalidBucketName");
      done();
    });
  });

  it("should fail to create a bucket because of invalid domain-style name", function(done) {
    s3Client.createBucket({ Bucket: ".example.com" }, err => {
      expect(err).to.exist;
      expect(err.statusCode).to.equal(400);
      expect(err.code).to.equal("InvalidBucketName");
      done();
    });
  });

  it("should fail to create a bucket because name is too long", function(done) {
    s3Client.createBucket({ Bucket: "abcd".repeat(16) }, err => {
      expect(err).to.exist;
      expect(err.statusCode).to.equal(400);
      expect(err.code).to.equal("InvalidBucketName");
      done();
    });
  });

  it("should fail to create a bucket because name is too short", function(done) {
    s3Client.createBucket({ Bucket: "ab" }, err => {
      expect(err).to.exist;
      expect(err.statusCode).to.equal(400);
      expect(err.code).to.equal("InvalidBucketName");
      done();
    });
  });

  it("should delete a bucket", function(done) {
    s3Client.deleteBucket({ Bucket: buckets[4] }, done);
  });

  it("should not fetch the deleted bucket", function(done) {
    s3Client.deleteBucket({ Bucket: buckets[4] }, err => {
      if (err) return done(err);
      s3Client.listObjects({ Bucket: buckets[4] }, err => {
        expect(err).to.exist;
        expect(err.code).to.equal("NoSuchBucket");
        expect(err.statusCode).to.equal(404);
        done();
      });
    });
  });

  it("should list no objects for a bucket", function(done) {
    s3Client.listObjects({ Bucket: buckets[3] }, (err, objects) => {
      if (err) return done(err);
      expect(objects.Contents).to.have.lengthOf(0);
      done();
    });
  });

  it("should store a text object in a bucket", function(done) {
    const params = { Bucket: buckets[0], Key: "text", Body: "Hello!" };
    s3Client.putObject(params, (err, data) => {
      if (err) return done(err);
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
      done();
    });
  });

  it("should store a text object with no content type and retrieve it", function(done) {
    request(
      {
        method: "PUT",
        baseUrl: s3Client.config.endpoint,
        url: `/${buckets[0]}/text`,
        body: "Hello!"
      },
      (err, res) => {
        if (err) return done(err);
        expect(res.statusCode).to.equal(200);
        const params = { Bucket: buckets[0], Key: "text" };
        s3Client.getObject(params, (err, data) => {
          if (err) return done(err);
          expect(data.ContentType).to.equal("binary/octet-stream");
          done();
        });
      }
    );
  });

  it("should trigger a Put event", function(done) {
    const params = { Bucket: buckets[0], Key: "testPutKey", Body: "Hello!" };
    const putSubs = s3rver.s3Event.subscribe(event => {
      expect(event.Records[0].eventName).to.equal("ObjectCreated:Put");
      expect(event.Records[0].s3.bucket.name).to.equal(buckets[0]);
      expect(event.Records[0].s3.object.key).to.equal("testPutKey");
      putSubs.unsubscribe();
      done();
    });
    s3Client.putObject(params, err => {
      if (err) return done(err);
    });
  });

  it("should trigger a Copy event", function(done) {
    const copySubs = s3rver.s3Event
      .filter(
        eventType => eventType.Records[0].eventName == "ObjectCreated:Copy"
      )
      .subscribe(event => {
        expect(event.Records[0].eventName).to.equal("ObjectCreated:Copy");
        expect(event.Records[0].s3.bucket.name).to.equal(buckets[4]);
        expect(event.Records[0].s3.object.key).to.equal("testCopy");
        copySubs.unsubscribe();
        done();
      });

    const putParams = { Bucket: buckets[0], Key: "testPut", Body: "Hello!" };
    s3Client.putObject(putParams, err => {
      if (err) return done(err);
      const params = {
        Bucket: buckets[4],
        Key: "testCopy",
        CopySource: "/" + buckets[0] + "/testPut"
      };
      s3Client.copyObject(params, err => {
        if (err) return done(err);
      });
    });
  });

  it("should trigger a Delete event", function(done) {
    const delSubs = s3rver.s3Event
      .filter(
        eventType => eventType.Records[0].eventName == "ObjectRemoved:Delete"
      )
      .subscribe(event => {
        expect(event.Records[0].eventName).to.equal("ObjectRemoved:Delete");
        expect(event.Records[0].s3.bucket.name).to.equal(buckets[0]);
        expect(event.Records[0].s3.object.key).to.equal("testDelete");
        delSubs.unsubscribe();
        done();
      });

    const putParams = { Bucket: buckets[0], Key: "testDelete", Body: "Hello!" };
    s3Client.putObject(putParams, err => {
      if (err) return done(err);
      s3Client.deleteObject({ Bucket: buckets[0], Key: "testDelete" }, err => {
        if (err) return done(err);
      });
    });
  });

  it("should store a text object with some custom metadata", function(done) {
    const params = {
      Bucket: buckets[0],
      Key: "textmetadata",
      Body: "Hello!",
      Metadata: {
        someKey: "value"
      }
    };
    s3Client.putObject(params, (err, data) => {
      if (err) return done(err);
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
      done();
    });
  });

  it("should return a text object with some custom metadata", function(done) {
    const params = {
      Bucket: buckets[0],
      Key: "textmetadata",
      Body: "Hello!",
      Metadata: {
        someKey: "value"
      }
    };
    s3Client.putObject(params, (err, data) => {
      if (err) return done(err);
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
      s3Client.getObject(
        { Bucket: buckets[0], Key: "textmetadata" },
        (err, object) => {
          if (err) return done(err);
          expect(object.Metadata.somekey).to.equal("value");
          done();
        }
      );
    });
  });

  it("should store an image in a bucket", function(done) {
    const file = path.join(__dirname, "resources/image.jpg");
    fs.readFile(file, (err, data) => {
      if (err) return done(err);
      const params = {
        Bucket: buckets[0],
        Key: "image",
        Body: new Buffer(data),
        ContentType: "image/jpeg",
        ContentLength: data.length
      };
      s3Client.putObject(params, (err, data) => {
        if (err) return done(err);
        expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
        done();
      });
    });
  });

  it("should store a gzip encoded file in bucket", function(done) {
    const file = path.join(__dirname, "resources/jquery.js.gz");
    const stats = fs.statSync(file);

    const params = {
      Bucket: buckets[0],
      Key: "jquery",
      Body: fs.createReadStream(file), // new Buffer(data),
      ContentType: "application/javascript",
      ContentEncoding: "gzip",
      ContentLength: stats.size
    };

    s3Client.putObject(params, err => {
      if (err) return done(err);

      s3Client.getObject(
        { Bucket: buckets[0], Key: "jquery" },
        (err, object) => {
          if (err) return done(err);
          expect(object.ContentLength).to.equal(stats.size);
          expect(object.ContentEncoding).to.equal("gzip");
          expect(object.ContentType).to.equal("application/javascript");
          done();
        }
      );
    });
  });

  it("should copy an image object into another bucket", function(done) {
    const srcKey = "image";
    const destKey = "image/jamie";

    const file = path.join(__dirname, "resources/image.jpg");
    fs.readFile(file, (err, data) => {
      if (err) {
        return done(err);
      }
      const params = {
        Bucket: buckets[0],
        Key: srcKey,
        Body: new Buffer(data),
        ContentType: "image/jpeg",
        ContentLength: data.length
      };
      s3Client.putObject(params, (err, data) => {
        if (err) return done(err);
        expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
        const params = {
          Bucket: buckets[3],
          Key: destKey,
          CopySource: "/" + buckets[0] + "/" + srcKey
        };
        s3Client.copyObject(params, (err, data) => {
          if (err) return done(err);
          expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
          expect(moment(data.LastModified).isValid()).to.be.true;
          done();
        });
      });
    });
  });

  it("should copy an image object into another bucket including its metadata", function(done) {
    const srcKey = "image";
    const destKey = "image/jamie";

    const file = path.join(__dirname, "resources/image.jpg");
    fs.readFile(file, (err, data) => {
      if (err) return done(err);
      const params = {
        Bucket: buckets[0],
        Key: srcKey,
        Body: new Buffer(data),
        ContentType: "image/jpeg",
        ContentLength: data.length,
        Metadata: {
          someKey: "value"
        }
      };
      s3Client.putObject(params, (err, data) => {
        if (err) return done(err);
        expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
        const params = {
          Bucket: buckets[3],
          Key: destKey,
          // MetadataDirective is implied to be COPY
          CopySource: "/" + buckets[0] + "/" + srcKey
        };
        s3Client.copyObject(params, err => {
          if (err) return done(err);
          s3Client.getObject(
            { Bucket: buckets[3], Key: destKey },
            (err, object) => {
              if (err) return done(err);
              expect(object.Metadata).to.have.property("somekey", "value");
              expect(object.ContentType).to.equal("image/jpeg");
              done();
            }
          );
        });
      });
    });
  });

  it("should update the metadata of an image object", function(done) {
    const srcKey = "image";
    const destKey = "image/jamie";

    const file = path.join(__dirname, "resources/image.jpg");
    fs.readFile(file, (err, data) => {
      if (err) return done(err);
      const params = {
        Bucket: buckets[0],
        Key: srcKey,
        Body: new Buffer(data),
        ContentType: "image/jpeg",
        ContentLength: data.length
      };
      s3Client.putObject(params, (err, data) => {
        if (err) return done(err);
        expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
        const params = {
          Bucket: buckets[3],
          Key: destKey,
          CopySource: "/" + buckets[0] + "/" + srcKey,
          MetadataDirective: "REPLACE",
          Metadata: {
            someKey: "value"
          }
        };
        s3Client.copyObject(params, err => {
          if (err) return done(err);
          s3Client.getObject(
            { Bucket: buckets[3], Key: destKey },
            (err, object) => {
              if (err) done(err);
              expect(object.Metadata).to.have.property("somekey", "value");
              expect(object.ContentType).to.equal("application/octet-stream");
              done();
            }
          );
        });
      });
    });
  });

  it("should copy an image object into another bucket and update its metadata", function(done) {
    const srcKey = "image";
    const destKey = "image/jamie";

    const file = path.join(__dirname, "resources/image.jpg");
    fs.readFile(file, (err, data) => {
      if (err) return done(err);
      const params = {
        Bucket: buckets[0],
        Key: srcKey,
        Body: new Buffer(data),
        ContentType: "image/jpeg",
        ContentLength: data.length
      };
      s3Client.putObject(params, err => {
        if (err) return done(err);
        const params = {
          Bucket: buckets[3],
          Key: destKey,
          CopySource: "/" + buckets[0] + "/" + srcKey,
          MetadataDirective: "REPLACE",
          Metadata: {
            someKey: "value"
          }
        };
        s3Client.copyObject(params, err => {
          if (err) return done(err);
          s3Client.getObject(
            { Bucket: buckets[3], Key: destKey },
            (err, object) => {
              if (err) return done(err);
              expect(object.Metadata.somekey).to.equal("value");
              expect(object.ContentType).to.equal("application/octet-stream");
              done();
            }
          );
        });
      });
    });
  });

  it("should fail to copy an image object because the object does not exist", function(done) {
    const params = {
      Bucket: buckets[3],
      Key: "image/jamie",
      CopySource: "/" + buckets[0] + "/doesnotexist"
    };
    s3Client.copyObject(params, err => {
      expect(err).to.exist;
      expect(err.code).to.equal("NoSuchKey");
      expect(err.statusCode).to.equal(404);
      done();
    });
  });

  it("should fail to copy an image object because the source bucket does not exist", function(done) {
    const params = {
      Bucket: buckets[3],
      Key: "image/jamie",
      CopySource: "/falsebucket/doesnotexist"
    };
    s3Client.copyObject(params, err => {
      expect(err).to.exist;
      expect(err.code).to.equal("NoSuchBucket");
      expect(err.statusCode).to.equal(404);
      done();
    });
  });

  it("should fail to update the metadata of an image object when no REPLACE MetadataDirective is specified", function(done) {
    const key = "image";

    const file = path.join(__dirname, "resources/image.jpg");
    fs.readFile(file, (err, data) => {
      if (err) return done(err);
      const params = {
        Bucket: buckets[0],
        Key: key,
        Body: new Buffer(data),
        ContentType: "image/jpeg",
        ContentLength: data.length
      };
      s3Client.putObject(params, (err, data) => {
        if (err) return done(err);
        expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
        const params = {
          Bucket: buckets[0],
          Key: key,
          CopySource: "/" + buckets[0] + "/" + key,
          Metadata: {
            someKey: "value"
          }
        };
        s3Client.copyObject(params, err => {
          expect(err).to.exist;
          expect(err.statusCode).to.equal(400);
          done();
        });
      });
    });
  });

  it("should store a large buffer in a bucket", function(done) {
    // 20M
    const b = new Buffer(20000000);
    const params = { Bucket: buckets[0], Key: "large", Body: b };
    s3Client.putObject(params, (err, data) => {
      if (err) return done(err);
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
      done();
    });
  });

  it("should get an image from a bucket", function(done) {
    const file = path.join(__dirname, "resources/image.jpg");
    fs.readFile(file, (err, data) => {
      if (err) return done(err);
      const params = {
        Bucket: buckets[0],
        Key: "image",
        Body: data,
        ContentType: "image/jpeg",
        ContentLength: data.length
      };
      s3Client.putObject(params, err => {
        if (err) return done(err);
        s3Client.getObject(
          { Bucket: buckets[0], Key: "image" },
          (err, object) => {
            if (err) return done(err);
            expect(object.ETag).to.equal(JSON.stringify(md5(data)));
            expect(object.ContentLength).to.equal(data.length);
            expect(object.ContentType).to.equal("image/jpeg");
            done();
          }
        );
      });
    });
  });

  it("should get partial image from a bucket with a range request", function(done) {
    const file = path.join(__dirname, "resources/image.jpg");
    fs.readFile(file, (err, data) => {
      if (err) return done(err);
      const params = {
        Bucket: buckets[0],
        Key: "image",
        Body: data,
        ContentType: "image/jpeg",
        ContentLength: data.length
      };
      s3Client.putObject(params, err => {
        if (err) return done(err);
        const url = s3Client.getSignedUrl("getObject", {
          Bucket: buckets[0],
          Key: "image"
        });
        request({ url, headers: { range: "bytes=0-99" } }, (err, response) => {
          if (err) return done(err);

          expect(response.statusCode).to.equal(206);
          expect(response.headers).to.have.property("content-range");
          expect(response.headers).to.have.property("accept-ranges");
          expect(response.headers).to.have.property("content-length", "100");
          done();
        });
      });
    });
  });

  it("should get image metadata from a bucket using HEAD method", function(done) {
    const file = path.join(__dirname, "resources/image.jpg");
    fs.readFile(file, (err, data) => {
      if (err) return done(err);
      const params = {
        Bucket: buckets[0],
        Key: "image",
        Body: data,
        ContentType: "image/jpeg",
        ContentLength: data.length
      };
      s3Client.putObject(params, err => {
        if (err) return done(err);
        s3Client.headObject(
          { Bucket: buckets[0], Key: "image" },
          (err, object) => {
            if (err) return done(err);
            expect(object.ETag).to.equal(JSON.stringify(md5(data)));
            expect(object.ContentLength).to.equal(data.length);
            expect(object.ContentType).to.equal("image/jpeg");
            done();
          }
        );
      });
    });
  });

  it("should store a different image and update the previous image", function(done) {
    async.waterfall(
      [
        /**
         * Get object from store
         */
        callback => {
          const file = path.join(__dirname, "resources/image.jpg");
          fs.readFile(file, (err, data) => {
            const params = {
              Bucket: buckets[0],
              Key: "image",
              Body: data,
              ContentType: "image/jpeg",
              ContentLength: data.length
            };
            s3Client.putObject(params, err => {
              if (err) return callback(err);
              s3Client.getObject(
                { Bucket: buckets[0], Key: "image" },
                callback
              );
            });
          });
        },
        /**
         * Store different object
         */
        (object, callback) => {
          const file = path.join(__dirname, "resources/image1.jpg");
          fs.readFile(file, (err, data) => {
            if (err) return callback(err);
            const params = {
              Bucket: buckets[0],
              Key: "image",
              Body: new Buffer(data),
              ContentType: "image/jpeg",
              ContentLength: data.length
            };
            s3Client.putObject(params, (err, storedObject) => {
              expect(storedObject.ETag).to.not.equal(object.ETag);
              callback(err, object);
            });
          });
        },
        /**
         * Get object again and do some comparisons
         */
        (object, callback) => {
          s3Client.getObject(
            { Bucket: buckets[0], Key: "image" },
            (err, newObject) => {
              if (err) return callback(err);
              expect(newObject.LastModified).to.not.equal(object.LastModified);
              expect(newObject.ContentLength).to.not.equal(
                object.ContentLength
              );
              callback();
            }
          );
        }
      ],
      done
    );
  });

  it("should get an objects acl from a bucket", function(done) {
    s3Client.getObjectAcl(
      { Bucket: buckets[0], Key: "image" },
      (err, object) => {
        if (err) return done(err);
        expect(object.Owner.DisplayName).to.equal("S3rver");
        done();
      }
    );
  });

  it("should delete an image from a bucket", function(done) {
    const b = new Buffer(10);
    const params = { Bucket: buckets[0], Key: "large", Body: b };
    s3Client.putObject(params, err => {
      if (err) return done(err);
      s3Client.deleteObject({ Bucket: buckets[0], Key: "image" }, done);
    });
  });

  it("should not find an image from a bucket", function(done) {
    s3Client.getObject({ Bucket: buckets[0], Key: "image" }, err => {
      expect(err).to.exist;
      expect(err.code).to.equal("NoSuchKey");
      expect(err.statusCode).to.equal(404);
      done();
    });
  });

  it("should not fail to delete a nonexistent object from a bucket", function(done) {
    s3Client.deleteObject({ Bucket: buckets[0], Key: "doesnotexist" }, done);
  });

  it("should fail to delete a bucket because it is not empty", function(done) {
    generateTestObjects(s3Client, buckets[0], 20, err => {
      if (err) return done(err);
      s3Client.deleteBucket({ Bucket: buckets[0] }, err => {
        expect(err).to.exist;
        expect(err.code).to.equal("BucketNotEmpty");
        expect(err.statusCode).to.equal(409);
        done();
      });
    });
  });

  it("should upload a text file to a multi directory path", function(done) {
    const params = {
      Bucket: buckets[0],
      Key: "multi/directory/path/text",
      Body: "Hello!"
    };
    s3Client.putObject(params, (err, data) => {
      if (err) return done(err);
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
      done();
    });
  });

  it("should upload a managed upload <=5MB", function(done) {
    const params = {
      Bucket: buckets[0],
      Key: "multi/directory/path/multipart",
      Body: Buffer.alloc(5e6)
    }; // 5MB
    s3Client.upload(params, (err, data) => {
      if (err) return done(err);
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
      done();
    });
  });

  it("should upload a managed upload >5MB (multipart upload)", function(done) {
    const params = {
      Bucket: buckets[0],
      Key: "multi/directory/path/multipart",
      Body: Buffer.alloc(2e7)
    }; // 20MB
    s3Client.upload(params, (err, data) => {
      if (err) return done(err);
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
      done();
    });
  });

  it("should find a text file in a multi directory path", function(done) {
    const params = {
      Bucket: buckets[0],
      Key: "multi/directory/path/text",
      Body: "Hello!"
    };
    s3Client.putObject(params, err => {
      if (err) return done(err);
      s3Client.getObject(
        { Bucket: buckets[0], Key: "multi/directory/path/text" },
        (err, object) => {
          if (err) return done(err);
          expect(object.ETag).to.equal(JSON.stringify(md5("Hello!")));
          expect(object.ContentLength).to.equal(6);
          expect(object.ContentType).to.equal("application/octet-stream");
          done();
        }
      );
    });
  });

  it("should list objects in a bucket", function(done) {
    // Create some test objects
    const testObjects = [
      "akey1",
      "akey2",
      "akey3",
      "key/key1",
      "key1",
      "key2",
      "key3"
    ];
    async.eachSeries(
      testObjects,
      (testObject, callback) => {
        const params = { Bucket: buckets[1], Key: testObject, Body: "Hello!" };
        s3Client.putObject(params, (err, object) => {
          if (err) return callback(err);
          expect(object.ETag).to.match(/[a-fA-F0-9]{32}/);
          callback();
        });
      },
      err => {
        if (err) return done(err);
        s3Client.listObjects({ Bucket: buckets[1] }, (err, objects) => {
          if (err) return done(err);
          expect(objects.Contents).to.have.lengthOf(testObjects.length);
          done();
        });
      }
    );
  });

  it("should list objects in a bucket filtered by a prefix", function(done) {
    const testObjects = [
      "akey1",
      "akey2",
      "akey3",
      "key/key1",
      "key1",
      "key2",
      "key3"
    ];
    async.eachSeries(
      testObjects,
      (testObject, callback) => {
        const params = { Bucket: buckets[1], Key: testObject, Body: "Hello!" };
        s3Client.putObject(params, callback);
      },
      err => {
        if (err) return done(err);
        // Create some test objects
        s3Client.listObjects(
          { Bucket: buckets[1], Prefix: "key" },
          (err, objects) => {
            if (err) return done(err);
            expect(objects.Contents).to.have.lengthOf(4);
            expect(find(objects.Contents, { Key: "akey1" })).to.not.exist;
            expect(find(objects.Contents, { Key: "akey2" })).to.not.exist;
            expect(find(objects.Contents, { Key: "akey3" })).to.not.exist;
            done();
          }
        );
      }
    );
  });

  it("should list objects in a bucket filtered by a prefix 2", function(done) {
    const testObjects = [
      "akey1",
      "akey2",
      "akey3",
      "key/key1",
      "key1",
      "key2",
      "key3"
    ];
    async.eachSeries(
      testObjects,
      (testObject, callback) => {
        const params = { Bucket: buckets[1], Key: testObject, Body: "Hello!" };
        s3Client.putObject(params, callback);
      },
      err => {
        if (err) return done(err);
        s3Client.listObjectsV2(
          { Bucket: buckets[1], Prefix: "key" },
          (err, objects) => {
            if (err) return done(err);
            expect(objects.Contents).to.have.lengthOf(4);
            expect(find(objects.Contents, { Key: "akey1" })).to.not.exist;
            expect(find(objects.Contents, { Key: "akey2" })).to.not.exist;
            expect(find(objects.Contents, { Key: "akey3" })).to.not.exist;
            done();
          }
        );
      }
    );
  });

  it("should list objects in a bucket filtered by a marker", function(done) {
    const testObjects = [
      "akey1",
      "akey2",
      "akey3",
      "key/key1",
      "key1",
      "key2",
      "key3"
    ];
    async.eachSeries(
      testObjects,
      (testObject, callback) => {
        const params = { Bucket: buckets[1], Key: testObject, Body: "Hello!" };
        s3Client.putObject(params, callback);
      },
      err => {
        if (err) return done(err);
        s3Client.listObjects(
          { Bucket: buckets[1], Marker: "akey3" },
          (err, objects) => {
            if (err) return done(err);
            expect(objects.Contents).to.have.lengthOf(4);
            done();
          }
        );
      }
    );
  });

  it("should list objects in a bucket filtered by a marker and prefix", function(done) {
    const testObjects = [
      "akey1",
      "akey2",
      "akey3",
      "key/key1",
      "key1",
      "key2",
      "key3"
    ];
    async.eachSeries(
      testObjects,
      (testObject, callback) => {
        const params = { Bucket: buckets[1], Key: testObject, Body: "Hello!" };
        s3Client.putObject(params, callback);
      },
      err => {
        if (err) return done(err);
        s3Client.listObjects(
          { Bucket: buckets[1], Prefix: "akey", Marker: "akey2" },
          (err, objects) => {
            if (err) return done(err);
            expect(objects.Contents).to.have.lengthOf(1);
            done();
          }
        );
      }
    );
  });

  it("should list objects in a bucket filtered by a delimiter", function(done) {
    const testObjects = [
      "akey1",
      "akey2",
      "akey3",
      "key/key1",
      "key1",
      "key2",
      "key3"
    ];
    async.eachSeries(
      testObjects,
      (testObject, callback) => {
        const params = { Bucket: buckets[1], Key: testObject, Body: "Hello!" };
        s3Client.putObject(params, callback);
      },
      err => {
        if (err) return done(err);
        s3Client.listObjects(
          { Bucket: buckets[1], Delimiter: "/" },
          (err, objects) => {
            if (err) return done(err);
            expect(objects.Contents).to.have.lengthOf(6);
            expect(find(objects.CommonPrefixes, { Prefix: "key/" })).to.exist;
            done();
          }
        );
      }
    );
  });

  it("should list folders in a bucket filtered by a prefix and a delimiter", function(done) {
    const testObjects = [
      { Bucket: buckets[5], Key: "folder1/file1.txt", Body: "Hello!" },
      { Bucket: buckets[5], Key: "folder1/file2.txt", Body: "Hello!" },
      { Bucket: buckets[5], Key: "folder1/folder2/file3.txt", Body: "Hello!" },
      { Bucket: buckets[5], Key: "folder1/folder2/file4.txt", Body: "Hello!" },
      { Bucket: buckets[5], Key: "folder1/folder2/file5.txt", Body: "Hello!" },
      { Bucket: buckets[5], Key: "folder1/folder2/file6.txt", Body: "Hello!" },
      { Bucket: buckets[5], Key: "folder1/folder4/file7.txt", Body: "Hello!" },
      { Bucket: buckets[5], Key: "folder1/folder4/file8.txt", Body: "Hello!" },
      {
        Bucket: buckets[5],
        Key: "folder1/folder4/folder5/file9.txt",
        Body: "Hello!"
      },
      { Bucket: buckets[5], Key: "folder1/folder3/file10.txt", Body: "Hello!" }
    ];

    async.eachSeries(
      testObjects,
      (testObject, callback) => {
        s3Client.putObject(testObject, callback);
      },
      err => {
        if (err) return done(err);
        s3Client.listObjects(
          { Bucket: buckets[5], Prefix: "folder1/", Delimiter: "/" },
          (err, objects) => {
            if (err) return done(err);
            expect(objects.CommonPrefixes).to.have.lengthOf(3);
            expect(find(objects.CommonPrefixes, { Prefix: "folder1/folder2/" }))
              .to.exist;
            expect(find(objects.CommonPrefixes, { Prefix: "folder1/folder3/" }))
              .to.exist;
            expect(find(objects.CommonPrefixes, { Prefix: "folder1/folder4/" }))
              .to.exist;
            done();
          }
        );
      }
    );
  });

  it("should list no objects because of invalid prefix", function(done) {
    // Create some test objects
    s3Client.listObjects(
      { Bucket: buckets[1], Prefix: "myinvalidprefix" },
      (err, objects) => {
        if (err) return done(err);
        expect(objects.Contents).to.have.lengthOf(0);
        done();
      }
    );
  });

  it("should list no objects because of invalid marker", function(done) {
    // Create some test objects
    s3Client.listObjects(
      { Bucket: buckets[1], Marker: "myinvalidmarker" },
      (err, objects) => {
        if (err) return done(err);
        expect(objects.Contents).to.have.lengthOf(0);
        done();
      }
    );
  });

  it("should generate a few thousand small objects", function(done) {
    this.timeout(0);
    const testObjects = [];
    for (let i = 1; i <= 2000; i++) {
      testObjects.push({ Bucket: buckets[2], Key: "key" + i, Body: "Hello!" });
    }
    async.eachSeries(
      testObjects,
      (testObject, callback) => {
        s3Client.putObject(testObject, (err, object) => {
          if (err) return callback(err);
          expect(object.ETag).to.match(/[a-fA-F0-9]{32}/);
          callback();
        });
      },
      done
    );
  });

  it("should return one thousand small objects", function(done) {
    this.timeout(0);
    generateTestObjects(s3Client, buckets[2], 2000, err => {
      if (err) return done(err);
      s3Client.listObjects({ Bucket: buckets[2] }, (err, objects) => {
        if (err) return done(err);
        expect(objects.Contents).to.have.lengthOf(1000);
        done();
      });
    });
  });

  it("should return 500 small objects", function(done) {
    this.timeout(0);
    generateTestObjects(s3Client, buckets[2], 1000, err => {
      if (err) return done(err);
      s3Client.listObjects(
        { Bucket: buckets[2], MaxKeys: 500 },
        (err, objects) => {
          if (err) return done(err);
          expect(objects.Contents).to.have.lengthOf(500);
          done();
        }
      );
    });
  });

  it("should delete 500 small objects", function(done) {
    this.timeout(0);
    generateTestObjects(s3Client, buckets[2], 500, err => {
      if (err) return done(err);
      const testObjects = [];
      for (let i = 1; i <= 500; i++) {
        testObjects.push({ Bucket: buckets[2], Key: "key" + i });
      }
      async.eachSeries(
        testObjects,
        (testObject, callback) => {
          s3Client.deleteObject(testObject, callback);
        },
        done
      );
    });
  });

  it("should delete 500 small objects with deleteObjects", function(done) {
    this.timeout(0);
    generateTestObjects(s3Client, buckets[2], 500, err => {
      if (err) return done(err);
      const deleteObj = { Objects: [] };
      for (let i = 501; i <= 1000; i++) {
        deleteObj.Objects.push({ Key: "key" + i });
      }
      s3Client.deleteObjects(
        { Bucket: buckets[2], Delete: deleteObj },
        (err, resp) => {
          if (err) return done(err);
          expect(resp.Deleted).to.exist;
          expect(resp.Deleted).to.have.lengthOf(500);
          expect(find(resp.Deleted, { Key: "key567" })).to.exist;
          done();
        }
      );
    });
  });

  it("should return nonexistent objects as deleted with deleteObjects", function(done) {
    const deleteObj = { Objects: [{ Key: "doesnotexist" }] };
    s3Client.deleteObjects(
      { Bucket: buckets[2], Delete: deleteObj },
      (err, resp) => {
        if (err) return done(err);
        expect(resp.Deleted).to.exist;
        expect(resp.Deleted).to.have.lengthOf(1);
        expect(find(resp.Deleted, { Key: "doesnotexist" })).to.exist;
        done();
      }
    );
  });

  it("should reach the server with a bucket vhost", function(done) {
    request(
      {
        url: s3Client.endpoint.href,
        headers: { host: buckets[0] + ".s3.amazonaws.com" }
      },
      (err, response, body) => {
        if (err) return done(err);

        expect(response.statusCode).to.equal(200);
        expect(body).to.include("ListBucketResult");
        done();
      }
    );
  });
});

describe("S3rver CORS Policy Tests", function() {
  const bucket = "foobars";
  let s3Client;

  before("Initialize bucket", function(done) {
    const s3rver = new S3rver({
      port: 4569,
      hostname: "localhost",
      silent: true
    }).run(err => {
      if (err) return done(err);

      s3Client = new AWS.S3({
        accessKeyId: "123",
        secretAccessKey: "abc",
        endpoint: util.format("http://%s:%d", "localhost", 4569),
        sslEnabled: false,
        s3ForcePathStyle: true
      });
      const file = fs.readFileSync("./test/resources/image.jpg");
      const params = {
        Bucket: bucket,
        Key: "image",
        Body: new Buffer(file),
        ContentType: "image/jpeg",
        ContentLength: file.length
      };
      s3Client
        .createBucket({ Bucket: bucket })
        .promise()
        .then(() => s3Client.putObject(params).promise())
        .then(() => s3rver.close(done))
        .catch(err => s3rver.close(() => done(err)));
    });
  });

  it("should add the Access-Control-Allow-Origin header for default (wildcard) configurations", function(done) {
    const origin = "http://a-test.example.com";
    const params = { Bucket: bucket, Key: "image" };
    const url = s3Client.getSignedUrl("getObject", params);
    const s3rver = new S3rver({
      port: 4569,
      hostname: "localhost",
      silent: true
    }).run(err => {
      if (err) return done(err);

      request({ url, headers: { origin } }, (err, response) => {
        s3rver.close(() => {
          if (err) return done(err);

          expect(response.statusCode).to.equal(200);
          expect(response.headers).to.have.property(
            "access-control-allow-origin",
            "*"
          );
          done();
        });
      });
    });
  });

  it("should add the Access-Control-Allow-Origin header for a matching origin", function(done) {
    const origin = "http://a-test.example.com";
    const params = { Bucket: bucket, Key: "image" };
    const url = s3Client.getSignedUrl("getObject", params);
    const s3rver = new S3rver({
      port: 4569,
      hostname: "localhost",
      silent: true,
      cors: fs.readFileSync("./test/resources/cors_test1.xml")
    }).run(err => {
      if (err) return done(err);

      request({ url, headers: { origin } }, (err, response) => {
        s3rver.close(() => {
          if (err) return done(err);

          expect(response.statusCode).to.equal(200);
          expect(response.headers).to.have.property(
            "access-control-allow-origin",
            origin
          );
          done();
        });
      });
    });
  });

  it("should match an origin to a CORSRule with a wildcard character", function(done) {
    const origin = "http://foo.bar.com";
    const params = { Bucket: bucket, Key: "image" };
    const url = s3Client.getSignedUrl("getObject", params);
    const s3rver = new S3rver({
      port: 4569,
      hostname: "localhost",
      silent: true,
      cors: fs.readFileSync("./test/resources/cors_test1.xml")
    }).run(err => {
      if (err) return done(err);

      request({ url, headers: { origin } }, (err, response) => {
        s3rver.close(() => {
          if (err) return done(err);

          expect(response.statusCode).to.equal(200);
          expect(response.headers).to.have.property(
            "access-control-allow-origin",
            origin
          );
          done();
        });
      });
    });
  });

  it("should not add the Access-Control-Allow-Origin header for a non-matching origin", function(done) {
    const origin = "http://b-test.example.com";
    const params = { Bucket: bucket, Key: "image" };
    const url = s3Client.getSignedUrl("getObject", params);
    const s3rver = new S3rver({
      port: 4569,
      hostname: "localhost",
      silent: true,
      cors: fs.readFileSync("./test/resources/cors_test1.xml")
    }).run(err => {
      if (err) return done(err);

      request({ url, headers: { origin } }, (err, response) => {
        s3rver.close(() => {
          if (err) return done(err);

          expect(response.statusCode).to.equal(200);
          expect(response.headers).to.not.have.property(
            "access-control-allow-origin"
          );
          done();
        });
      });
    });
  });

  it("should expose appropriate headers for a range request", function(done) {
    const origin = "http://a-test.example.com";
    const params = { Bucket: bucket, Key: "image" };
    const url = s3Client.getSignedUrl("getObject", params);
    const s3rver = new S3rver({
      port: 4569,
      hostname: "localhost",
      silent: true,
      cors: fs.readFileSync("./test/resources/cors_test1.xml")
    }).run(err => {
      if (err) return done(err);

      request(
        { url, headers: { origin, range: "bytes=0-99" } },
        (err, response) => {
          s3rver.close(() => {
            if (err) return done(err);

            expect(response.statusCode).to.equal(206);
            expect(response.headers).to.have.property(
              "access-control-expose-headers",
              "Accept-Ranges, Content-Range"
            );
            done();
          });
        }
      );
    });
  });

  it("should respond to OPTIONS requests with allowed headers", function(done) {
    const origin = "http://foo.bar.com";
    const params = { Bucket: bucket, Key: "image" };
    const url = s3Client.getSignedUrl("getObject", params);
    const s3rver = new S3rver({
      port: 4569,
      hostname: "localhost",
      silent: true,
      cors: fs.readFileSync("./test/resources/cors_test1.xml")
    }).run(err => {
      if (err) return done(err);

      request(
        {
          method: "OPTIONS",
          url,
          headers: {
            origin,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "Range, Authorization"
          }
        },
        (err, response) => {
          s3rver.close(() => {
            if (err) return done(err);
            expect(response.statusCode).to.equal(200);
            expect(response.headers).to.have.property(
              "access-control-allow-origin",
              "*"
            );
            expect(response.headers).to.have.property(
              "access-control-allow-headers",
              "range, authorization"
            );
            done();
          });
        }
      );
    });
  });

  it("should respond to OPTIONS requests with a Forbidden response", function(done) {
    const origin = "http://a-test.example.com";
    const params = { Bucket: bucket, Key: "image" };
    const url = s3Client.getSignedUrl("getObject", params);
    const s3rver = new S3rver({
      port: 4569,
      hostname: "localhost",
      silent: true,
      cors: fs.readFileSync("./test/resources/cors_test1.xml")
    }).run(err => {
      if (err) return done(err);

      request(
        {
          method: "OPTIONS",
          url,
          headers: {
            origin,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "Range, Authorization"
          }
        },
        (err, response) => {
          s3rver.close(() => {
            if (err) return done(err);
            expect(response.statusCode).to.equal(403);
            done();
          });
        }
      );
    });
  });

  it("should respond to OPTIONS requests with a Forbidden response when CORS is disabled", function(done) {
    const origin = "http://foo.bar.com";
    const params = { Bucket: bucket, Key: "image" };
    const url = s3Client.getSignedUrl("getObject", params);
    const s3rver = new S3rver({
      port: 4569,
      hostname: "localhost",
      silent: true,
      cors: false
    }).run(err => {
      if (err) return done(err);

      request(
        {
          method: "OPTIONS",
          url,
          headers: {
            origin,
            "Access-Control-Request-Method": "GET"
          }
        },
        (err, response) => {
          s3rver.close(() => {
            if (err) return done(err);
            expect(response.statusCode).to.equal(403);
            done();
          });
        }
      );
    });
  });
});

describe("S3rver Tests with Static Web Hosting", function() {
  let s3Client;
  let s3rver;

  beforeEach("Reset site bucket", resetTmpDir);
  beforeEach("Start s3rver", function(done) {
    s3rver = new S3rver({
      port: 5694,
      hostname: "localhost",
      silent: true,
      indexDocument: "index.html",
      errorDocument: "",
      directory: tmpDir
    }).run((err, hostname, port) => {
      if (err) return done(err);
      s3Client = new AWS.S3({
        accessKeyId: "123",
        secretAccessKey: "abc",
        endpoint: util.format("http://%s:%d", hostname, port),
        sslEnabled: false,
        s3ForcePathStyle: true
      });
      done();
    });
  });

  afterEach(function(done) {
    s3rver.close(done);
  });

  it("should upload a html page to / path", function(done) {
    const bucket = "site";
    s3Client.createBucket({ Bucket: bucket }, err => {
      if (err) return done(err);
      const params = {
        Bucket: bucket,
        Key: "index.html",
        Body: "<html><body>Hello</body></html>"
      };
      s3Client.putObject(params, (err, data) => {
        if (err) return done(err);
        expect(data.ETag).to.match(/[a-fA-F0-9]{32}/);
        done();
      });
    });
  });

  it("should upload a html page to a directory path", function(done) {
    const bucket = "site";
    s3Client.createBucket({ Bucket: bucket }, err => {
      if (err) return done(err);
      const params = {
        Bucket: bucket,
        Key: "page/index.html",
        Body: "<html><body>Hello</body></html>"
      };
      s3Client.putObject(params, (err, data) => {
        if (err) return done(err);
        expect(data.ETag).to.match(/[a-fA-F0-9]{32}/);
        done();
      });
    });
  });

  it("should get an index page at / path", function(done) {
    const bucket = "site";
    s3Client.createBucket({ Bucket: bucket }, err => {
      if (err) return done(err);
      const expectedBody = "<html><body>Hello</body></html>";
      const params = { Bucket: bucket, Key: "index.html", Body: expectedBody };
      s3Client.putObject(params, err => {
        if (err) return done(err);
        request(s3Client.endpoint.href + "site/", (error, response, body) => {
          if (error) return done(error);

          expect(response.statusCode).to.equal(200);
          expect(body).to.equal(expectedBody);
          done();
        });
      });
    });
  });

  it("should get an index page at /page/ path", function(done) {
    const bucket = "site";
    s3Client.createBucket({ Bucket: bucket }, err => {
      if (err) return done(err);
      const expectedBody = "<html><body>Hello</body></html>";
      const params = {
        Bucket: bucket,
        Key: "page/index.html",
        Body: expectedBody
      };
      s3Client.putObject(params, err => {
        if (err) return done(err);
        request(
          s3Client.endpoint.href + "site/page/",
          (err, response, body) => {
            if (err) return done(err);

            expect(response.statusCode).to.equal(200);
            expect(body).to.equal(expectedBody);
            done();
          }
        );
      });
    });
  });

  it("should get a 404 error page", function(done) {
    const bucket = "site";
    s3Client.createBucket({ Bucket: bucket }, err => {
      if (err) return done(err);
      request(
        s3Client.endpoint.href + "site/page/not-exists",
        (err, response) => {
          if (err) return done(err);

          expect(response.statusCode).to.equal(404);
          expect(response.headers).to.have.property(
            "content-type",
            "text/html"
          );
          done();
        }
      );
    });
  });
});

describe("S3rver Class Tests", function() {
  it("should merge default options with provided options", function() {
    const s3rver = new S3rver({
      hostname: "testhost",
      indexDocument: "index.html",
      errorDocument: "",
      directory: "./testdir",
      key: new Buffer([1, 2, 3]),
      cert: new Buffer([1, 2, 3]),
      removeBucketsOnClose: true
    });

    expect(s3rver.options).to.have.property("hostname", "testhost");
    expect(s3rver.options).to.have.property("port", 4578);
    expect(s3rver.options).to.have.property("silent", false);
    expect(s3rver.options).to.have.property("indexDocument", "index.html");
    expect(s3rver.options).to.have.property("errorDocument", "");
    expect(s3rver.options).to.have.property("directory", "./testdir");
    expect(s3rver.options).to.have.property("key");
    expect(s3rver.options).to.have.property("cert");
    expect(s3rver.options.key).to.be.an.instanceOf(Buffer);
    expect(s3rver.options.cert).to.be.an.instanceOf(Buffer);
    expect(s3rver.options).to.have.property("removeBucketsOnClose", true);
  });
  it("should support running on port 0", function(done) {
    const s3rver = new S3rver({
      port: 0,
      hostname: "localhost",
      silent: true
    }).run((err, hostname, port) => {
      if (err) return done(err);
      expect(port).to.be.above(0);
      s3rver.close(done);
    });
  });
});

describe("Data directory cleanup", function() {
  beforeEach("Reset buckets", resetTmpDir);

  it("Cleans up after close if the removeBucketsOnClose setting is true", function(done) {
    const bucket = "foobars";

    const s3rver = new S3rver({
      port: 4569,
      hostname: "localhost",
      silent: true,
      removeBucketsOnClose: true
    }).run((err, hostname, port, directory) => {
      if (err) return done(err);

      const s3Client = new AWS.S3({
        accessKeyId: "123",
        secretAccessKey: "abc",
        endpoint: util.format("http://%s:%d", hostname, port),
        sslEnabled: false,
        s3ForcePathStyle: true
      });
      s3Client.createBucket({ Bucket: bucket }, err => {
        if (err) return done(err);
        generateTestObjects(s3Client, bucket, 10, err => {
          if (err) return done(err);
          s3rver.close(err => {
            if (err) return done(err);
            const exists = fs.existsSync(directory);
            expect(exists).to.be.true;
            const files = fs.readdirSync(directory);
            expect(files).to.have.lengthOf(0);
            done();
          });
        });
      });
    });
  });

  it("Does not clean up after close if the removeBucketsOnClose setting is false", function(done) {
    const bucket = "foobars";

    const s3rver = new S3rver({
      port: 4569,
      hostname: "localhost",
      silent: true,
      removeBucketsOnClose: false
    }).run((err, hostname, port, directory) => {
      if (err) return done(err);

      const s3Client = new AWS.S3({
        accessKeyId: "123",
        secretAccessKey: "abc",
        endpoint: util.format("http://%s:%d", hostname, port),
        sslEnabled: false,
        s3ForcePathStyle: true
      });
      s3Client.createBucket({ Bucket: bucket }, err => {
        if (err) return done(err);
        generateTestObjects(s3Client, bucket, 10, err => {
          if (err) return done(err);
          s3rver.close(err => {
            if (err) return done(err);
            const exists = fs.existsSync(directory);
            expect(exists).to.be.true;
            const files = fs.readdirSync(directory);
            expect(files).to.have.lengthOf(1);
            done();
          });
        });
      });
    });
  });

  it("Does not clean up after close if the removeBucketsOnClose setting is not set", function(done) {
    const bucket = "foobars";

    const s3rver = new S3rver({
      port: 4569,
      hostname: "localhost",
      silent: true
    }).run((err, hostname, port, directory) => {
      if (err) return done(err);
      const s3Client = new AWS.S3({
        accessKeyId: "123",
        secretAccessKey: "abc",
        endpoint: util.format("http://%s:%d", hostname, port),
        sslEnabled: false,
        s3ForcePathStyle: true
      });
      s3Client.createBucket({ Bucket: bucket }, err => {
        if (err) return done(err);
        generateTestObjects(s3Client, bucket, 10, err => {
          if (err) return done(err);
          s3rver.close(err => {
            if (err) return done(err);
            const exists = fs.existsSync(directory);
            expect(exists).to.be.true;
            const files = fs.readdirSync(directory);
            expect(files).to.have.lengthOf(1);
            done();
          });
        });
      });
    });
  });

  it("Can delete a bucket that is empty after some key that includes a directory has been deleted", function(done) {
    const bucket = "foobars";

    const s3rver = new S3rver({
      port: 4569,
      hostname: "localhost",
      silent: true
    }).run((err, hostname, port) => {
      if (err) return done(err);
      const s3Client = new AWS.S3({
        accessKeyId: "123",
        secretAccessKey: "abc",
        endpoint: util.format("http://%s:%d", hostname, port),
        sslEnabled: false,
        s3ForcePathStyle: true
      });
      s3Client
        .createBucket({ Bucket: bucket })
        .promise()
        .then(() =>
          s3Client
            .putObject({ Bucket: bucket, Key: "foo/foo.txt", Body: "Hello!" })
            .promise()
        )
        .then(() =>
          s3Client
            .deleteObject({ Bucket: bucket, Key: "foo/foo.txt" })
            .promise()
        )
        .then(() => s3Client.deleteBucket({ Bucket: bucket }).promise())
        .then(() => s3rver.close(done))
        .catch(err => s3rver.close(() => done(err)));
    });
  });

  it("Can put an object in a bucket that is empty after some key that does not include a directory has been deleted", function(done) {
    const bucket = "foobars";

    const s3rver = new S3rver({
      port: 4569,
      hostname: "localhost",
      silent: true
    }).run((err, hostname, port) => {
      if (err) return done(err);
      const s3Client = new AWS.S3({
        accessKeyId: "123",
        secretAccessKey: "abc",
        endpoint: util.format("http://%s:%d", hostname, port),
        sslEnabled: false,
        s3ForcePathStyle: true
      });
      s3Client
        .createBucket({ Bucket: bucket })
        .promise()
        .then(() =>
          s3Client
            .putObject({ Bucket: bucket, Key: "foo.txt", Body: "Hello!" })
            .promise()
        )
        .then(() =>
          s3Client.deleteObject({ Bucket: bucket, Key: "foo.txt" }).promise()
        )
        .then(() =>
          s3Client
            .putObject({ Bucket: bucket, Key: "foo2.txt", Body: "Hello2!" })
            .promise()
        )
        .then(() => s3rver.close(done))
        .catch(err => s3rver.close(() => done(err)));
    });
  });
});
