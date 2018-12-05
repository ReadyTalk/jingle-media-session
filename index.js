var util = require('util');
var extend = require('extend-object');
var BaseSession = require('jingle-session');
var RTCPeerConnection = require('rtcpeerconnection');
var queue = require('queue');

var jmglobal;

function filterContentSources(content, stream) {
    if (content.application.applicationType !== 'rtp') {
        return;
    }
    delete content.transport;
    delete content.application.payloads;
    delete content.application.headerExtensions;
    content.application.mux = false;

    if (content.application.sources) {
        content.application.sources = content.application.sources.filter(function (source) {
            // if there's no msid, ignore it
            if (source.parameters.length < 2) {
              return false;
            }
        
            console.log('stream id: ', stream, source.parameters);
            return (stream.id === source.parameters[1].value.split(' ')[0] 
              || stream.label === source.parameters[1].value.split(' ')[0]);
        });
    }

    // remove source groups not related to this stream
    if (content.application.sourceGroups) {
        content.application.sourceGroups = content.application.sourceGroups.filter(function (group) {
            var found = false;
            for (var i = 0; i < content.application.sources.length; i++) {
                if (content.application.sources[i].ssrc === group.sources[0]) {
                    found = true;
                    break;
                }
            }
            return found;
        });
    }
}


function filterUnusedLabels(content) {
    // Remove mslabel and label ssrc-specific attributes
    var sources = content.application.sources || [];
    sources.forEach(function (source) {
        source.parameters = source.parameters.filter(function (parameter) {
            return !(parameter.key === 'mslabel' || parameter.key === 'label');
        });
    });
}

function findMatchingContentBlock(content, jingleDescription) {
    var contents = jingleDescription.contents || [];
    var matchingContents = contents.filter(function (compareContent) {
        return content.name === compareContent.name;
    });
    // intentionally returns null if more than one is matched as that shouldn't normally happen
    if (matchingContents.length === 1) {
        return matchingContents[0];
    }
    return null;
}

function findMatchingSource(baseSource, compareSources) {
    compareSources = compareSources || [];
    for (var i = 0; i < compareSources.length; i++) {
        var compareSource = compareSources[i];
        if (baseSource.ssrc === compareSource.ssrc) {
            return compareSource;
        }
    }
    return null;
}

function sourceHasMsid(source) {
    return source.parameters && source.parameters.some(function(param) { return param.key === 'msid'; });
}

function changeSendersIfNoMsids(content) {
    if (!content.application) {
        return;
    }

    // remove sources that are missing an msid (they are recvonly)
    var sources = content.application.sources || [];
    var hasSourcesWithMsids = sources.some(sourceHasMsid);
    if (!hasSourcesWithMsids) {
        content.senders = 'both';
    }
}

// When we remove a source and need to add a recvonly source
function filterAddRecvOnlyIfNotPresent(newContent, oldContent) {
    if (newContent.application.applicationType !== 'rtp') {
        return;
    }

    delete newContent.transport;
    delete newContent.application.payloads;
    delete newContent.application.headerExtensions;
    delete newContent.application.ssrc;
    newContent.application.mux = false;

    console.log('filterAddRecvOnlyIfNotPresent');
    console.log('newContent shit:', newContent.senders);
    console.log('oldShit', oldContent.senders);
    //direction application.senders  
    if (newContent.application.sources && newContent.senders === 'initiator') {
        newContent.application.sources = newContent.application.sources.filter(function (baseSource) {
            
            
            // if there's a msid, ignore it because its not recvonly
            // if (sourceHasMsid(baseSource)) {
            //   return false;
            // }


            // try to find correpsonding source in compareContent if it exists
            var foundNewRecvonlySource = false;
            if (oldContent) {
                var compareSource = findMatchingSource(baseSource, oldContent.application.sources);
                // if the source is new or the source is now read only
                // if(!compareSource || (compareSource && sourceHasMsid(compareSource))) {
                if (!compareSource && oldContent.senders === 'both') {
                    foundNewRecvonlySource = true;
                }
            } else {
                foundNewRecvonlySource = true;
            }
            return foundNewRecvonlySource;
        });
    }
    // remove source groups not related to this stream
    if (newContent.application.sourceGroups) {
        newContent.application.sourceGroups = newContent.application.sourceGroups.filter(function (group) {
            var found = false;
            for (var i = 0; i < newContent.application.sources.length; i++) {
                if (newContent.application.sources[i].ssrc === group.sources[0]) {
                    found = true;
                    break;
                }
            }
            return found;
        });
    }
    return newContent.application.sources.length;

};


// filters the sources in baseContent to only include sources which don't have an msid (recvonly) and are new
// (not in compareContent sources) or that have a corresponding source in compareContent that has an msid (indicating)
// that the source changed from recvonly to sendrecv. If no compareContent is passed in then it will filter the 
// content block to any sources without an msid
// Returns a boolean indicating that there are recvonly sources
function filterToMatchingRecvonly(baseContent, compareContent) {
    // if the content is not rtp, ignore it
    if (baseContent.application.applicationType !== 'rtp') {
        return;
    }

    delete baseContent.transport;
    delete baseContent.application.payloads;
    delete baseContent.application.headerExtensions;
    delete baseContent.application.ssrc;
    baseContent.application.mux = false;

    if (baseContent.application.sources) {
        baseContent.application.sources = baseContent.application.sources.filter(function (baseSource) {
            // if there's a msid, ignore it because its not recvonly
            if (sourceHasMsid(baseSource)) {
              return false;
            }

            // try to find correpsonding source in compareContent if it exists
            var foundNewRecvonlySource = false;
            if (compareContent) {
                var compareSource = findMatchingSource(baseSource, compareContent.application.sources);
                // if the source is new or the source is now read only
                if(!compareSource || (compareSource && sourceHasMsid(compareSource))) {
                    foundNewRecvonlySource = true;
                }
            } else {
                foundNewRecvonlySource = true;
            }
            return foundNewRecvonlySource;
        });
    }
    // remove source groups not related to this stream
    if (baseContent.application.sourceGroups) {
        baseContent.application.sourceGroups = baseContent.application.sourceGroups.filter(function (group) {
            var found = false;
            for (var i = 0; i < baseContent.application.sources.length; i++) {
                if (baseContent.application.sources[i].ssrc === group.sources[0]) {
                    found = true;
                    break;
                }
            }
            return found;
        });
    }
    return baseContent.application.sources.length;
}

function MediaSession(opts) {
    BaseSession.call(this, opts);

    this.pc = new RTCPeerConnection({
        iceServers: opts.iceServers || [],
        useJingle: true
    }, opts.constraints || {});

    this.q = queue({
      autostart: true,
      concurrency: 1
    });

    this.pc.on('ice', this.onIceCandidate.bind(this, opts));
    this.pc.on('endOfCandidates', this.onIceEndOfCandidates.bind(this, opts));
    this.pc.on('iceConnectionStateChange', this.onIceStateChange.bind(this));
    this.pc.on('addStream', this.onAddStream.bind(this));
    this.pc.on('removeStream', this.onRemoveStream.bind(this));
    this.pc.on('addChannel', this.onAddChannel.bind(this));
    // this.pc.on('negotiationNeeded', this.onNegotiationNeeded.bind(this));

    if (opts.stream) {
        this.addStream(opts.stream);
    }

    this._ringing = false;
}


function queueOfferAnswer(self, errorMsg, jingleDesc, cb) {

  console.log('jm - queueOfferAnswer jingleDesc', jingleDesc);

  self.q.push(function(qCb) {
    function done(err, answer) {
      qCb();
      return (err ? cb(err) : cb(null, answer));
    }

    self.pc.handleOffer({
      type: 'offer',
      jingle: jingleDesc
    }, function (err) {
      if (err) {
        self._log('error', 'Could not create offer for ' + errorMsg);
        return done(err);
      }

      self.pc.answer(self.constraints, function (err, answer) {
        if (err) {
          self._log('error', 'Could not create answer for ' + errorMsg);
          return done(err);
        }

        // call the remaing logic in the cb
        done(null, answer);
      });
    });
  });
}


function queueOffer(self, errorMsg, jingleDesc, cb) {
  self.q.push(function(qCb) {
    function done(err) {
      qCb();
      return (err ? cb(err) : cb(null));
    }

    self.pc.handleOffer({
      type: 'offer',
      jingle: jingleDesc
    }, function (err) {
      if (err) {
        self._log('error', errorMsg);
        return done(err);
      }

      // call the remaing logic in the cb
      done();
    });
  });
}


function queueAnswer(self, errorMsg, jingleDesc, cb) {
  self.q.push(function(qCb) {
    function done(err, answer) {
      qCb();
      return (err ? cb(err) : cb(null, answer));
    }

    self.pc.handleAnswer({
      type: 'answer',
      jingle: jingleDesc
    }, function (err) {
      if (err) {
        self._log('error', errorMsg);
        return done(err);
      }

      // call the remaing logic in the cb
      done();
    });
  });
}


util.inherits(MediaSession, BaseSession);


Object.defineProperties(MediaSession.prototype, {
    ringing: {
        get: function () {
            return this._ringing;
        },
        set: function (value) {
            if (value !== this._ringing) {
                this._ringing = value;
                this.emit('change:ringing', value);
            }
        }
    },
    streams: {
        get: function () {
            if (this.pc.signalingState !== 'closed') {
                return this.pc.getRemoteStreams();
            }
            return [];
        }
    }
});


MediaSession.prototype = extend(MediaSession.prototype, {

    // ----------------------------------------------------------------
    // Session control methods
    // ----------------------------------------------------------------

    start: function (offerOptions, next) {
        var self = this;
        this.state = 'pending';

        next = next || function () {};

        this.pc.isInitiator = true;
        self.q.push(function(qCb) {
          self.pc.offer(offerOptions, function (err, offer) {
              if (err) {
                  self._log('error', 'Could not create WebRTC offer', err);
                  return self.end('failed-application', true);
              }

              // a workaround for missing a=sendonly
              // https://code.google.com/p/webrtc/issues/detail?id=1553
              if (offerOptions && offerOptions.mandatory) {
                  offer.jingle.contents.forEach(function (content) {
                      var mediaType = content.application.media;

                      if (!content.description || content.application.applicationType !== 'rtp') {
                          return;
                      }

                      if (!offerOptions.mandatory.OfferToReceiveAudio && mediaType === 'audio') {
                          content.senders = 'initiator';
                      }

                      if (!offerOptions.mandatory.OfferToReceiveVideo && mediaType === 'video') {
                          content.senders = 'initiator';
                      }
                  });
              }

              offer.jingle.contents.forEach(filterUnusedLabels);

              self.send('session-initiate', offer.jingle);

              next();
              qCb();
          });
        });
    },

    accept: function (opts, next) {
        var self = this;

        // support calling with accept(next) or accept(opts, next)
        if (arguments.length === 1 && typeof opts === 'function') {
            next = opts;
            opts = {};
        }
        next = next || function () {};
        opts = opts || {};

        self.constraints = opts.constraints || {
            mandatory: {
                OfferToReceiveAudio: true,
                OfferToReceiveVideo: true
            }
        };

        self._log('info', 'Accepted incoming session');

        self.state = 'active';

        self.q.push(function(qCb) {
          self.pc.answer(self.constraints, function (err, answer) {
            if (err) {
              self._log('error', 'Could not create WebRTC answer', err);
              return self.end('failed-application');
            }

            answer.jingle.contents.forEach(filterUnusedLabels);
            // this isn't needed current because we are signaling a source-remove and then source-add when adding a stream
            // leaving here since the source-remove, source-add solution breaks firefox -> chrome
            // answer.jingle.contents.forEach(filterOutRecvonly);
            answer.jingle.contents.forEach(changeSendersIfNoMsids);

            self.send('session-accept', answer.jingle);

            next();
            qCb();
          });
        });
    },

    end: function (reason, silent) {
        var self = this;
        this.streams.forEach(function (stream) {
            self.onRemoveStream({stream: stream});
        });
        this.pc.close();
        BaseSession.prototype.end.call(this, reason, silent);
    },

    ring: function () {
        this._log('info', 'Ringing on incoming session');
        this.ringing = true;
        this.send('session-info', {ringing: true});
    },

    mute: function (creator, name) {
        this._log('info', 'Muting', name);

        this.send('session-info', {
            mute: {
                creator: creator,
                name: name
            }
        });
    },

    unmute: function (creator, name) {
        this._log('info', 'Unmuting', name);
        this.send('session-info', {
            unmute: {
                creator: creator,
                name: name
            }
        });
    },

    hold: function () {
        this._log('info', 'Placing on hold');
        this.send('session-info', {hold: true});
    },

    resume: function () {
        this._log('info', 'Resuming from hold');
        this.send('session-info', {active: true});
    },

    // ----------------------------------------------------------------
    // Stream control methods
    // ----------------------------------------------------------------

    addStream: function (stream, renegotiate, cb) {
        console.log('jm addStream');
        var self = this;
        var oldLocalDescription = JSON.parse(JSON.stringify(self.pc.localDescription));

        cb = cb || function () {};

        this.pc.addStream(stream);

        if (!renegotiate) {
            return;
        } else if (typeof renegotiate === 'object') {
            self.constraints = renegotiate;
        }

        var errorMsg = 'adding new stream';
        queueOfferAnswer(this, errorMsg, self.pc.remoteDescription, function(err, answer) {
          if (err) {
            self._log('error', 'Could not create offer for ' + errorMsg);
            return cb(err);
          }

          answer.jingle.contents.forEach(function (content) {
            filterContentSources(content, stream);
          });
          answer.jingle.contents = answer.jingle.contents.filter(function (content) {
            return content.application.applicationType === 'rtp' 
                && content.application.sources 
                && content.application.sources.length;
          });
          delete answer.jingle.groups;

          var newLocalDescription = JSON.parse(JSON.stringify(self.pc.localDescription));
          const newSsrcs = self._doShit(oldLocalDescription, newLocalDescription);
        //   self._removeRecvOnlySourceIfPresent(oldLocalDescription, newLocalDescription);

          if (answer.jingle) {
            self.send('source-add', answer.jingle);
          }
          return cb();
        });

    },

    addStream2: function (stream, cb) {
        this.addStream(stream, true, cb);
    },

    removeStream: function (stream, renegotiate, cb) {
        console.log('jm removeStream');
        var self = this;
        var oldLocalDescription = JSON.parse(JSON.stringify(self.pc.localDescription));

        cb = cb || function () {};

        if (!renegotiate) {
            this.pc.removeStream(stream);
            return;
        } else if (typeof renegotiate === 'object') {
            self.constraints = renegotiate;
        }

        var desc = this.pc.localDescription;
        desc.contents.forEach(function (content) {
            filterContentSources(content, stream);
        });
        desc.contents = desc.contents.filter(function (content) {
            return content.application.applicationType === 'rtp' && content.application.sources && content.application.sources.length;
        });
        delete desc.groups;

        if (desc.contents.length) {
            console.log('jm remove this source dewd: ', desc);
            this.send('source-remove', desc);
        }
 
        this.pc.removeStream(stream);

        var errorMsg = 'removing stream';
        queueOfferAnswer(self, errorMsg, this.pc.remoteDescription, function(err) {
            if (err) {
                return cb(err);
            }

            var newLocalDescription = JSON.parse(JSON.stringify(self.pc.localDescription));
            const newSsrcs = self._doShit(oldLocalDescription, newLocalDescription);
            // self._addRecvOnlySourceIfNotPresent(oldLocalDescription, newLocalDescription);
            cb();
        });
    },

    removeStream2: function (stream, cb) {
        this.removeStream(stream, true, cb);
    },

    _removeShit: function(oldLocalDescription, newLocalDescription) {
        const desc = oldLocalDescription;
        delete desc.group;
        function getContent(content) {
            return content.application.applicationType === 'rtp' 
            && content.application.sources 
            && content.application.sources.length;
        }
        const oldContents = oldLocalDescription.contents.filter(getContent);
        const newContents = newLocalDescription.contents.filter(getContent);
        console.log('jm remove shit oldContents: ', oldContents, newContents);

        for (var i = 0; i < newContents; i++) {

        }
    },
    // Justin's new functions
    _doShit: function(oldLocalDescription, newLocalDescription) {
        const desc = oldLocalDescription;
        delete desc.group;

        function getContent(content) {
            return content.application.applicationType === 'rtp' 
            && content.application.sources 
            && content.application.sources.length;
        }

        const oldContents = oldLocalDescription.contents.filter(getContent);
        const newContents = newLocalDescription.contents.filter(getContent);
        console.log('jm oldContents: ', oldContents, newContents);

        const a = {};
        const sourcesRemoved = [];
        const sourcesModified = [];
        const sourcesToAddBack = [];

        for (var i = 0; i < newContents.length; i++) {
            console.log('jm new contents', newContents[i].application.sources.length);
            for(var j = 0; j < newContents[i].application.sources.length; j++) {
                console.log('jm new content sources: ', newContents[i].application.sources[j].ssrc);
                a[newContents[i].application.sources[j].ssrc] = {
                    source: newContents[i].application.sources[j],
                    direction: newContents[i].senders,
                };
            }
        };
    
        for (var i = 0; i < oldContents.length; i++) {
            for(var j = 0; j < oldContents[i].application.sources.length; j++) {
                if (!a[oldContents[i].application.sources[j].ssrc]) {
                    // this IS a removed ssource
                    sourcesRemoved.push(oldContents[i].application.sources[j].ssrc);
                }
                else {
                    // this is a possible modified source
                    const oldContentHasMsid = sourceHasMsid(oldContents[i].application.sources[j]);
                    const oldContentSourceDirection = oldContents[i].senders;
                    const newContentHasMsid = sourceHasMsid(a[oldContents[i].application.sources[j].ssrc].source);
                    const newContentSourceDirection = a[oldContents[i].application.sources[j].ssrc].direction;

                    if (newContentSourceDirection !== oldContentSourceDirection) {
                        // Direction has changed
                        delete oldContents[i].transport;
                        delete oldContents[i].application.payloads;

                        console.log('jm direction change detected')

                        switch (newContentSourceDirection) {
                            case 'both':
                                // if newContent does not have msid don't change direction.
                                if (!newContentHasMsid) {
                                    console.log('jm trying to changed direction to sendrecv that does not have a msid: ', oldContents[i].application.sources[j].ssrc);    
                                }
                                else {
                                    console.log('jm newContent is now sendrecv -> send sr (old) sa(new)', oldContents[i].application.sources[j].ssrc);
                                    sourcesModified.push(oldContents[i].application.sources[j].ssrc);
                                }
                            break;
                            case 'initiator':
                                console.log('jm newContent is now recvonly -> send sr (new) sa(old)', oldContents[i].application.sources[j].ssrc);
                                sourcesToAddBack.push(oldContents[i].application.sources[j].ssrc);
                            break;
                            default:
                            console.log('jm I should not be here');
                        }    
                    }
                    else {
                        if(oldContentHasMsid && !newContentHasMsid) {
                            console.log('jm the msid from the newcontent was created');
                        }    
                    }
                }
                delete a[oldContents[i].application.sources[j].ssrc];
            }
        }

        console.log('jm b4 shit: ', Object.keys(a));
        const sourcesAdded = [];

        Object.keys(a).forEach(function(ssrc) {
            for (var i = 0; i < newContents.length; i++) {
                
                newContents[i].application.sources = 
                newContents[i].application.sources.filter(function(source) {
                    return source.ssrc === ssrc;
                });

                if (newContents[i].application.sources.length) {
                   delete newContents[i].transport;
                   delete newContents[i].ssrc;
                   delete newContents[i].application.payloads;
                   sourcesAdded.push(newContents[i]);
                } 
            }
        });

        console.log('jm removedSources: ', sourcesRemoved);
        console.log('jm sourcesAdded: ', sourcesAdded);
        console.log('jm sourcesModifed: ', sourcesModified);
        console.log('jm sourcesToAddBack: ', sourcesToAddBack)

        if (sourcesAdded.length) {
           const new_desc = newLocalDescription;
           delete new_desc.groups;
           new_desc.contents = sourcesAdded;
           this.send('source-add', new_desc);
        }

        function getProperSSRCS(contents, ssrcList) {
            const properContents = [];
            for (var i = 0; i < contents.length; i++) {
                const filteredSsrcs = 
                    contents[i].application.sources.filter(function(source) {
                        return ssrcList.indexOf(source.ssrc) > -1;
                    });
                
                if (filteredSsrcs.length) {
                    contents[i].application.sources = filteredSsrcs;
                    delete contents[i].transport;
                    delete contents[i].ssrc;
                    delete contents[i].application.payloads;
                    contents[i].application.mux = false;
                    contents[i].application.headerExtensions = [];
                    properContents.push(contents[i]);
                }
            }
            return properContents;
        }

        if (sourcesModified.length) {
            const new_desc = newLocalDescription;

            const jmContent = getProperSSRCS(oldContents, sourcesModified);
            const jmContent2 = getProperSSRCS(newContents, sourcesModified);
        
            desc.contents = jmContent;
            new_desc.contents = jmContent2;
            delete desc.groups;
            delete new_desc.groups;
            desc.contents.forEach(function(content) {
                content.application.sources.forEach(function(source) {
                    source.parameters = source.parameters.filter(function(param) {
                        if (param.key === 'msid') {
                            return false;
                        }
                        return true;
                    });
                });
            });

            this.send('source-remove', desc);
            this.send('source-add', new_desc);
        }
        if (sourcesToAddBack.length) {
            const new_desc = newLocalDescription;
            const jmContent = getProperSSRCS(oldContents, sourcesToAddBack);
            const jmContent2 = getProperSSRCS(newContents, sourcesToAddBack);

            console.log('jmContents: ', jmContent, jmContent2);
            desc.contents = jmContent;
            new_desc.contents = jmContent2;
            delete desc.groups;
            delete new_desc.groups;
            
            new_desc.contents.forEach(function(content) {
                content.application.sources.forEach(function(source) {
                    source.parameters = source.parameters.filter(function(param) {
                        if (param.key === 'msid') {
                            return false;
                        }
                        return true;
                    });
                });
            });
            // desc.contents = sourcesToAddBack;
            this.send('source-remove', desc);
            this.send('source-add', new_desc);  
        }

    },

    _removeRecvOnlySourceIfPresent: function(oldLocalDescription, newLocalDescription) {
        var desc = oldLocalDescription;

        console.log('_removeRecvOnlySourceIfPresent: ', oldLocalDescription, newLocalDescription);

        // filter to only sources that changed from recvonly to sendrecv
        desc.contents = desc.contents.filter(function(oldContent) {
        
            if (oldContent.application.applicationType === 'rtp'
              && oldContent.application.sources 
              && oldContent.application.sources.length) {
                var newContent = findMatchingContentBlock(oldContent, newLocalDescription);
                console.log('oC sender: ' + oldContent.senders + ' nC sender: ' + newContent.senders)
                // if (oldContent.senders === 'both' && newContent.senders === 'both') {
                //   return false;
                // }
                // the filter function handles the case where oldContent is null
                return filterToMatchingRecvonly(oldContent, newContent);
            }
        });
        delete desc.groups;
        if (desc.contents.length > 0) {
            console.log('_removeRecvOnlySourceIfPresent found content remove', desc.contents.length);
            // remove msids
            desc.contents.forEach(function(content) {
                content.application.sources.forEach(function(source) {
                    source.parameters = source.parameters.filter(function(param) {
                        if (param.key === 'msid') {
                            return false;
                        }
                        return true;
                    });
                });
            })
            console.log('jm send sr');
            this.send('source-remove', desc);
        }
        else {
            console.log('_removeRecvOnlySourceIfPresent no recv-only content to remove');
        }
    },

    _addRecvOnlySourceIfNotPresent: function(oldLocalDescription, newLocalDescription) {
        var desc = newLocalDescription;

        // filter to only sources that changed from recvonly to sendrecv
        desc.contents = desc.contents.filter(function(newContent) {
            if (newContent.application.applicationType === 'rtp'
                && newContent.application.media === 'video'
                && newContent.application.sources 
                && newContent.application.sources.length) {
                var oldContent = findMatchingContentBlock(newContent, oldLocalDescription);
                // the filter function handles the case where oldContent is null
                return filterAddRecvOnlyIfNotPresent(newContent, oldContent);
                // return filterToMatchingRecvonly(newContent, oldContent);
            }
        });
        delete desc.groups;
        if (desc.contents.length > 0) {
            // remove msids
            desc.contents.forEach(function(content) {
                content.application.sources.forEach(function(source) {
                    source.parameters = source.parameters.filter(function(param) {
                        if (param.key === 'msid') {
                            return false;
                        }
                        return true;
                    });
                });
            })
    
            this.send('source-add', desc);
        }
    },

    switchStream: function (oldStream, newStream, cb) {
        var self = this;

        cb = cb || function () {};

        var desc = this.pc.localDescription;
        desc.contents.forEach(function (content) {
            delete content.transport;
            delete content.application.payloads;
        });

        this.pc.removeStream(oldStream);
        this.send('source-remove', desc);

        this.pc.addStream(newStream);

        var errorMsg = 'switching streams';
        queueOfferAnswer(self, errorMsg, this.pc.remoteDescription, function(err, answer) {
          if (err) {
            self._log('error', 'Could not create offer for ' + errorMsg);
            return cb(err);
          }

          answer.jingle.contents.forEach(function (content) {
            delete content.transport;
            delete content.application.payloads;
          });
          self.send('source-add', answer.jingle);
          return err ? cb(err) : cb();
        });
    },

    // ----------------------------------------------------------------
    // ICE action handers
    // ----------------------------------------------------------------

    onIceCandidate: function (opts, candidate) {
        this._log('info', 'Discovered new ICE candidate', candidate.jingle);
        this.send('transport-info', candidate.jingle);
        if (opts.signalEndOfCandidates) {
            this.lastCandidate = candidate;
        }
    },

    onIceEndOfCandidates: function (opts) {
        this._log('info', 'ICE end of candidates');
        if (opts.signalEndOfCandidates) {
            var endOfCandidates = this.lastCandidate.jingle;
            endOfCandidates.contents[0].transport = {
                transportType: endOfCandidates.contents[0].transport.transportType,
                gatheringComplete: true
            };
            this.lastCandidate = null;
            this.send('transport-info', endOfCandidates);
        }
    },

    onIceStateChange: function () {
        switch (this.pc.iceConnectionState) {
            case 'checking':
                this.connectionState = 'connecting';
                break;
            case 'completed':
            case 'connected':
                this.connectionState = 'connected';
                break;
            case 'disconnected':
                if (this.pc.signalingState === 'stable') {
                    this.connectionState = 'interrupted';
                } else {
                    this.connectionState = 'disconnected';
                }
                break;
            case 'failed':
                this.connectionState = 'failed';
                this.end('failed-transport');
                break;
            case 'closed':
                this.connectionState = 'disconnected';
                break;
        }
    },

    // ----------------------------------------------------------------
    // Stream event handlers
    // ----------------------------------------------------------------

    onAddStream: function (event) {
        this._log('info', 'Stream added');
        this.emit('peerStreamAdded', this, event.stream);
    },

    onRemoveStream: function (event) {
        this._log('info', 'Stream removed');
        this.emit('peerStreamRemoved', this, event.stream);
    },

    // ----------------------------------------------------------------
    // Jingle action handers
    // ----------------------------------------------------------------

    onSessionInitiate: function (changes, cb) {
        this._log('info', 'Initiating incoming session');

        this.state = 'pending';

        this.pc.isInitiator = false;
        var errorMsg = 'Could not create WebRTC answer';
        queueOffer(this, errorMsg, changes, function(err) {
          return err ? cb({condition: 'general-error'}) : cb();
        });
    },

    onSessionAccept: function (changes, cb) {
        var self = this;

        this.state = 'active';

        var errorMsg = 'Could not process WebRTC answer';
        queueAnswer(this, errorMsg, changes, function(err) {
          if (err) {
            return cb({condition: 'general-error'});
          }
          self.emit('accepted', self);
          cb();
        });
    },

    onSessionTerminate: function (changes, cb) {
        var self = this;

        this._log('info', 'Terminating session');
        this.streams.forEach(function (stream) {
            self.onRemoveStream({stream: stream});
        });
        this.pc.close();
        BaseSession.prototype.end.call(this, changes.reason, true);

        cb();
    },

    onSessionInfo: function (info, cb) {
        if (info.ringing) {
            this._log('info', 'Outgoing session is ringing');
            this.ringing = true;
            this.emit('ringing', this);
            return cb();
        }

        if (info.hold) {
            this._log('info', 'On hold');
            this.emit('hold', this);
            return cb();
        }

        if (info.active) {
            this._log('info', 'Resuming from hold');
            this.emit('resumed', this);
            return cb();
        }

        if (info.mute) {
            this._log('info', 'Muting', info.mute);
            this.emit('mute', this, info.mute);
            return cb();
        }

        if (info.unmute) {
            this._log('info', 'Unmuting', info.unmute);
            this.emit('unmute', this, info.unmute);
            return cb();
        }

        cb();
    },

    onTransportInfo: function (changes, cb) {
      var self = this;
      self.q.push(function(qCb) {
        function done() {
          qCb();
          return cb();
        }

        self.pc.processIce(changes, function () {
          done();
        });
      });
    },

    onSourceAdd: function (changes, cb) {
        var self = this;
        this._log('info', 'Adding new stream source');

        var newDesc = this.pc.remoteDescription;
        this.pc.remoteDescription.contents.forEach(function (content, idx) {
            var desc = content.application;
            var ssrcs = desc && desc.sources || [];
            var groups = desc && desc.sourceGroups || [];

            if (!changes.contents) {
                return;
            }

            changes.contents.forEach(function (newContent) {
                if (content.name !== newContent.name) {
                    return;
                }

                var newContentDesc = newContent.application;
                var newSSRCs = newContentDesc.sources || [];

                ssrcs = ssrcs.concat(newSSRCs);
                newDesc.contents[idx].application.sources = JSON.parse(JSON.stringify(ssrcs));

                var newGroups = newContentDesc.sourceGroups || [];
                groups = groups.concat(newGroups);
                newDesc.contents[idx].application.sourceGroups = JSON.parse(JSON.stringify(groups));
            });
        });

        var errorMsg = 'adding new stream source';
        var oldLocalDescription = JSON.parse(JSON.stringify(self.pc.localDescription));
        queueOfferAnswer(self, errorMsg, newDesc, function(err) {
            if (err) {
                return cb({condition: 'general-error'});
            }
            
            var newLocalDescription = JSON.parse(JSON.stringify(self.pc.localDescription));
            const newSsrcs = self._doShit(oldLocalDescription, newLocalDescription, true);
            // self._addRecvOnlySourceIfNotPresent(oldLocalDescription, newLocalDescription);
            return cb();
        });
    },

    onSourceRemove: function (changes, cb) {
        var self = this;
        this._log('info', 'Removing stream source');

        var newDesc = this.pc.remoteDescription;
        this.pc.remoteDescription.contents.forEach(function (content, idx) {
            var desc = content.application;
            var ssrcs = desc && desc.sources || [];
            var groups = desc && desc.sourceGroups || [];

            changes.contents.forEach(function (newContent) {
                if (content.name !== newContent.name) {
                    return;
                }

                var newContentDesc = newContent.application;
                var newSSRCs = newContentDesc.sources || [];
                var newGroups = newContentDesc.sourceGroups || [];

                var found, i, j, k;


                for (i = 0; i < newSSRCs.length; i++) {
                    found = -1;
                    for (j = 0; j < ssrcs.length; j++) {
                        if (newSSRCs[i].ssrc === ssrcs[j].ssrc) {
                            found = j;
                            break;
                        }
                    }
                    if (found > -1) {
                        ssrcs.splice(found, 1);
                        newDesc.contents[idx].application.sources = JSON.parse(JSON.stringify(ssrcs));
                    }
                }

                // Remove ssrc-groups that are no longer needed
                for (i = 0; i < newGroups.length; i++) {
                    found = -1;
                    for (j = 0; j < groups.length; j++) {
                        if (newGroups[i].semantics === groups[j].semantics &&
                            newGroups[i].sources.length === groups[j].sources.length) {
                            var same = true;
                            for (k = 0; k < newGroups[i].sources.length; k++) {
                                if (newGroups[i].sources[k] !== groups[j].sources[k]) {
                                    same = false;
                                    break;
                                }
                            }
                            if (same) {
                                found = j;
                                break;
                            }
                        }
                    }
                    if (found > -1) {
                        groups.splice(found, 1);
                        newDesc.contents[idx].application.sourceGroups = JSON.parse(JSON.stringify(groups));
                    }
                }
            });
        });

        var errorMsg = 'removing stream source';
        var oldLocalDescription = JSON.parse(JSON.stringify(self.pc.localDescription));
        queueOfferAnswer(this, errorMsg, newDesc, function(err) {
            if (err) {
                return cb({condition: 'general-error'});
            }
            var newLocalDescription = JSON.parse(JSON.stringify(self.pc.localDescription));
            const newSsrcs = self._doShit(oldLocalDescription, newLocalDescription);
            
            // self._removeRecvOnlySourceIfPresent(oldLocalDescription, newLocalDescription);
            return cb();
        });
    },

    // ----------------------------------------------------------------
    // DataChannels
    // ----------------------------------------------------------------
    onAddChannel: function (channel) {
        this.emit('addChannel', channel);
    }
});


module.exports = MediaSession;
