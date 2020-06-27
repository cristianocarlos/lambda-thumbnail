// dependencies
var async = require('async');
var AWS = require('aws-sdk');
var gm = require('gm').subClass({imageMagick: true, appPath: '/opt/bin/'}); // Enable ImageMagick integration.
var gs = require('gs');
var util = require('util');
var fs = require('fs');

// constants
var MAX_WIDTH  = 296;
var MAX_HEIGHT = 296;
var BUCKET_SUFIX = '-thumbnail';
var ALLOWED_FILETYPES = ['png', 'jpg', 'jpeg', 'pdf'];

// get reference to S3 client 
var s3 = new AWS.S3();
 
exports.handler = function (event, context, callback) {
  // Read options from the event.
  console.log("Reading options from event:\n", util.inspect(event, {depth: 5}));
  var srcBucket = event.Records[0].s3.bucket.name;
  // Object key may have spaces or unicode non-ASCII characters.
  var srcKey = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, " "));  
  var dstBucket = srcBucket + BUCKET_SUFIX;
  var dstKey = srcKey;

  // Sanity check: validate that source and destination are different buckets.
  if (srcBucket == dstBucket) {
    callback('Source and destination buckets are the same.');
    return;
  }

  // Infer the image type.
  var typeMatch = srcKey.match(/\.([^.]*)$/);
  if (!typeMatch) {
    callback('Could not determine the image type.');
    return;
  }
  
  var imageType = typeMatch[1];
  if (ALLOWED_FILETYPES.indexOf(imageType) === -1) {
    callback('Unsupported image type: ${imageType}');
    return;
  }

  // Download the image from S3, transform, and upload to a different S3 bucket.
  async.waterfall(
    [
      function download (next) {
        // Download the image from S3 into a buffer.
        s3.getObject({
            Bucket: srcBucket,
            Key: srcKey
        }, next);
      },
      function convertIfPdf (response, next) {
        if (imageType == 'pdf') {
          fs.writeFile('/tmp/temp.pdf', response.Body, function (err) {
            if (!err) {
              gs().batch().nopause().executablePath('/opt/bin/./gs').device('png16m').input("/tmp/temp.pdf").output('/tmp/temp.png').exec(function (err, stdout, stderr){
                if (!err && !stderr) {
                  var data = fs.readFileSync('/tmp/temp.png');
                  next(null, data);
                } else {
                  console.error('ERROR convertIfPdf err: ' + err);
                  console.error('ERROR convertIfPdf stderr: ' + stderr);
                }
              });
            }
          });
        } else {
          next(null, response);
        }
      },
      function transform (response, next) {
        var image;
        var resolvedImageType;
        var resolvedContentType;
        if (imageType === 'pdf') {
          image = gm(response);
          resolvedContentType = 'image/png';
          resolvedImageType = 'png';
        } else {
          image = gm(response.Body);
          resolvedContentType = response.ContentType;
          resolvedImageType = imageType
        }
        image.size(function (err, size) {
          if (!err) {
            // Infer the scaling factor to avoid stretching the image unnaturally.
            var scalingFactor = Math.min(
                MAX_WIDTH / size.width,
                MAX_HEIGHT / size.height
            );
            var width  = scalingFactor * size.width;
            var height = scalingFactor * size.height;
  
            // Transform the image buffer in memory.
            this.resize(width, height).toBuffer(resolvedImageType, function (err, buffer) {
              if (err) {
                next(err);
              } else {
                next(null, resolvedContentType, buffer);
              }
            });
          } else {
            console.error('ERROR transform image.size: ' + err);
          }
        });
      },
      function upload (contentType, data, next) {
        // Stream the transformed image to a different S3 bucket.
        if (imageType === 'pdf') {
          dstKey = dstKey + '.png';
        }
        s3.putObject({
          Bucket: dstBucket,
          Key: dstKey,
          Body: data,
          ContentType: contentType
        }, next);
      }
    ], 
    function (err) {
      if (err) {
        console.error(
          'Unable to resize ' + srcBucket + '/' + srcKey +
          ' and upload to ' + dstBucket + '/' + dstKey +
          ' due to an error: ' + err
        );
      } else {
        console.log(
          'Successfully resized ' + srcBucket + '/' + srcKey +
          ' and uploaded to ' + dstBucket + '/' + dstKey
        );
      }
      callback(null, 'message');
    }
  );
};
