/* global ns */
/**
 * @class
 * @alias H5PEditor.SelectorHub
 */
ns.SelectorHub = function (libraries, selectedLibrary, changeLibraryDialog) {
  var self = this;

  H5P.EventDispatcher.call(this);

  /**
   * Looks up content type object
   *
   * @param {string} machineName
   * @return {object}
   */
  this.getContentType = function (machineName) {
    for (var i = 0; i < libraries.libraries.length; i++) {
      var contentType = libraries.libraries[i];

      if (contentType.machineName === machineName) {
        return contentType;
      }
    }
  };

  var state = {
    contentId: H5PEditor.contentId || 0,
    contentTypes: libraries,
    getAjaxUrl: H5PEditor.getAjaxUrl,
    expanded: true,
    canPaste: false
  };

  if (selectedLibrary) {
    var contentType = this.getContentType(selectedLibrary.split(' ')[0]);
    state.title = contentType ? contentType.title || contentType.machineName : selectedLibrary.split(' ')[0];
    state.expanded = false;
  }

  // Initialize hub client
  this.client = new H5P.HubClient(state, H5PEditor.language.core);

  // Default to nothing selected and empty params
  this.currentLibrary = selectedLibrary;

  // Listen for content type selection
  this.client.on('select', function (event) {
    var contentType = event;

    // Already selected library
    if (contentType.machineName === self.currentLibrary.split(' ')[0]) {
      return;
    }

    if (!self.currentLibrary) {
      self.currentLibrary = self.createContentTypeId(contentType, true);
      self.trigger('selected');
      return;
    }

    self.currentLibrary = self.createContentTypeId(contentType, true);
    delete self.currentParams;
    delete self.currentMetadata;
    changeLibraryDialog.show(ns.$(self.getElement()).offset().top);
  }, this);

  // Listen for uploads
  this.client.on('upload', function (event) {
    libraries = event.contentTypes;
    var previousLibrary = self.currentLibrary;

    // Use version from event data
    const uploadedVersion = event.h5p.preloadedDependencies
      .filter(function (dependency) {
        return dependency.machineName === event.h5p.mainLibrary;
      })[0];
    self.currentLibrary = self.createContentTypeId(uploadedVersion);
    self.currentParams = event.content;
    self.currentMetadata = {
      title: event.h5p.title,
      authors: event.h5p.authors,
      license: event.h5p.license,
      licenseVersion: event.h5p.licenseVersion,
      licenseExtras: event.h5p.licenseExtras,
      yearFrom: event.h5p.yearFrom,
      yearTo: event.h5p.yearTo,
      source: event.h5p.source,
      changes: event.h5p.changes,
      authorComments: event.h5p.authorComments,
      defaultLanguage: event.h5p.defaultLanguage
    };

    /**
     * Change library immediately or show confirmation dialog
     * @private
     */
    const selectLibrary = function () {
      if (!previousLibrary) {
        self.trigger('selected');
      }
      else {
        changeLibraryDialog.show(ns.$(self.getElement()).offset().top);
      }
    };

    /**
     * Use backend to filter parameter values according to semantics
     *
     * @private
     * @param {Object} library
     */
    const filterParameters = function (library) {
      const libraryString = ns.ContentType.getNameVersionString(library);

      var formData = new FormData();
      formData.append('libraryParameters', JSON.stringify({
        library: libraryString,
        params: self.currentParams,
        metadata: self.currentMetadata
      }));
      var request = new XMLHttpRequest();
      request.onload = function () {
        try {
          result = JSON.parse(request.responseText);
          self.currentLibrary = result.data.library;
          self.currentParams = result.data.params;
          self.currentMetadata = result.data.metadata;
          markAllFilesAsTemporary(libraryString);
        }
        catch (err) {
          H5P.error(err);
        }
      };
      request.open('POST', H5PEditor.getAjaxUrl('filter'), true);
      request.send(formData);
    };

    /**
     * Tag all files as temporary (this is necessary for them to be marked as permanent upon save)
     * @private
     */
    const markAllFilesAsTemporary = function (libraryString) {
      ns.loadLibrary(libraryString, function () {
        processSemantics(ns.libraryCache[libraryString].semantics, self.currentParams, selectLibrary);
      });
    };

    /**
     * Process semantics
     *
     * @private
     * @param {Array} semantics
     * @param {Object} params
     * @param {function} done
     */
    const processSemantics = function (semantics, params, done) {
      if (!semantics || !semantics.length) {
        return done();
      }

      let numFinished = 0;
      for (let i = 0; i < semantics.length; i++) {
        if (params[semantics[i].name] !== undefined) {
          processField(semantics[i], params[semantics[i].name], function () {
            numFinished++;
            if (numFinished === semantics.length) {
              done();
            }
          });
        }
        else {
          numFinished++;
          if (numFinished === semantics.length) {
            done();
          }
        }
      }
    };

    /**
     * Process a single field.
     *
     * @param {Object} field
     * @param {*} params
     * @param {function} done
     */
    const processField = function (field, params, done) {
      let isDone = true;
      switch (field.type) {
        case 'file':
        case 'image':
          if (params.path !== undefined) {
            processFile(params);

            // Process original image
            if (params.originalImage !== undefined && params.originalImage.path !== undefined) {
              processFile(params.originalImage);
            }
          }
          break;

        case 'video':
        case 'audio':
          if (params[0] !== undefined) {
            for (let i = 0; i < params.length; i++) {
              processFile(params[i]);
            }
          }
          break;

        case 'library':
          if (params.library !== undefined && params.params !== undefined) {
            isDone = false; // Async
            ns.loadLibrary(params.library, function () {
              processSemantics(ns.libraryCache[params.library].semantics, params.params, done);
            });
          }
          break;

        case 'group':
          if (params !== undefined) {
            const isSubContent = (field.isSubContent == true);
            if (field.fields.length == 1 && !isSubContent) {
              if (params !== undefined) {
                isDone = false; // Async
                processField(field.fields[0], params, done);
              }
            }
            else {
              isDone = false; // Async
              processSemantics(field.fields, params, done);
            }
          }
          break;

        case 'list':
          if (params[0] !== undefined) {
            isDone = false; // Async
            let numFinished = 0;
            for (let j = 0; j < params.length; j++) {
              processField(field.field, params[j], function () {
                numFinished++;
                if (numFinished === params.length) {
                  done();
                }
              });
            }
          }
          break;
      }
      if (isDone) {
        done();
      }
    }

    /**
     * Add '#tmp' suffix to file path.
     *
     * @private
     * @param {*} params
     */
    const processFile = function (params) {
      if (params.path.match(/^https?:\/\//i)) {
        return; // Skip external files
      }

      // Add temporary file suffix
      params.path += '#tmp';
    }

    // Check if we have any newer versions
    const upgradeLibrary = ns.ContentType.getPossibleUpgrade(uploadedVersion, libraries.libraries);
    if (upgradeLibrary) {
      // We need to run content upgrade before showing the editor
      ns.upgradeContent(uploadedVersion, upgradeLibrary, {params: self.currentParams, metadata: self.currentMetadata}, function (err, result) {
        if (err) {
          // Reset the Hub
          var contentType = self.getContentType(self.currentLibrary.split(' ')[0]);
          self.client.setPanelTitle(contentType.title || contentType.machineName, true);
        }
        else {
          const content = JSON.parse(result);
          self.currentParams = content.params;
          self.currentMetadata = content.metadata;
          self.currentLibrary = self.createContentTypeId(upgradeLibrary, true);
          filterParameters(upgradeLibrary);
        }
      })
    }
    else {
      filterParameters(uploadedVersion);
    }

  }, this);

  this.client.on('update', function (event) {
    // Handle update to the content type cache
    libraries = event;
  });

  this.client.on('resize', function () {
    self.trigger('resize');
  });

  this.client.on('paste', function () {
    self.trigger('paste');
  });
};

// Extends the event dispatcher
ns.SelectorHub.prototype = Object.create(H5P.EventDispatcher.prototype);
ns.SelectorHub.prototype.constructor = ns.SelectorHub;

/**
 * Reset current library to the provided library.
 *
 * @param {string} library Full library name
 * @param {Object} params Library parameters
 * @param {Object} metadata Library metadata
 * @param {boolean} expanded Selector open
 */
ns.SelectorHub.prototype.resetSelection = function (library, params, metadata, expanded) {
  this.currentLibrary = library;
  this.currentParams = params;
  this.currentMetadata = metadata;

  var contentType = this.getContentType(library.split(' ')[0]);
  this.client.setPanelTitle(contentType.title || contentType.machineName, expanded);
};

/**
 * Reset current library to the provided library.
 *
 * @param {boolean} canPaste
 */
ns.SelectorHub.prototype.setCanPaste = function (canPaste) {
  this.client.setCanPaste(canPaste);
};

/**
 * Get currently selected library
 *
 * @param {function} next Callback
 */
ns.SelectorHub.prototype.getSelectedLibrary = function (next) {
  var selected = {
    uberName: this.currentLibrary
  };

  var contentType = this.getContentType(this.currentLibrary.split(' ')[0]);
  if (contentType) {
    selected.tutorialUrl = contentType.tutorial;
    selected.exampleUrl = contentType.example;
  }

  return next(selected);
};

/**
 * Get params connected with the currently selected library
 *
 * @returns {object} Parameters connected to the selected library
 */
ns.SelectorHub.prototype.getParams = function () {
  return this.currentParams;
};

/**
 * Get metadata connected with the currently selected library
 *
 * @returns {object} Metadata connected to the selected library
 */
ns.SelectorHub.prototype.getMetadata = function () {
  return this.currentMetadata;
};

/**
 * Returns the html element for the hub
 *
 * @public
 * @return {HTMLElement}
 */
ns.SelectorHub.prototype.getElement = function () {
  return this.client.getElement();
};

/**
 * Takes a content type, and extracts the full id (ubername)
 *
 * @param {ContentType} contentType
 * @param {boolean} [useLocalVersion] Decides if we should use local version or cached version
 *
 * @private
 * @return {string}
 */
ns.SelectorHub.prototype.createContentTypeId = function (contentType, useLocalVersion) {
  var id = contentType.machineName;
  if (useLocalVersion) {
    id += ' ' + contentType.localMajorVersion + '.' + contentType.localMinorVersion;
  }
  else {
    id += ' ' + contentType.majorVersion + '.' + contentType.minorVersion;
  }

  return id;
};
