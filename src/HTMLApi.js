"use strict";

//data, schemasUrl, docs, user, curlUser, cb

function HTMLApi(opt, cb)
{
  var self = this;
  this._schemas     = null;
  this._schemaDocs  = null;
  this._data        = opt.data;
  this._docsPage    = opt.docsPage;
  this._docsJson    = opt.docsJson;
  this._user        = opt.user;
  this._curlUser    = opt.curlUser || '${API_ACCESS_KEY}:${API_SECRET_KEY}';
  this._logout      = opt.logout !== false;

  this._filterId    = 0;
  this._reqModal    = null;
  this._editSchema  = null;
  this._editData    = null;
  this._lastMethod  = null;
  this._lastMode    = null;
  this._lastType    = null;
  this._lastOpt     = null;
  this._lastRequestBody    = null;
  this._error = null;

  this._referenceDropdownLimit = 100;
  this._magicNull = "__-*NULL*-__";
  this._magicNullRegex= new RegExp(this._escapeRegex(this._magicNull)+'$');

  this._formatter = new JSONFormatter({
    baseUrl: window.location.protocol +"//" + window.location.host,
    keyFormatter: this.keyFormatter.bind(this),
    valueFormatter: this.valueFormatter.bind(this)
  });

  async.auto({
    title:                      this.titleUpdate.bind(this),
    rawSchema:                  this.schemasLoad.bind(this, opt.schemasUrl),
    schema:     ['rawSchema',   this.schemasMunge.bind(this)  ],
    docs:       ['schema',      this.docsLoad.bind(this, opt.docsJson) ],
  }, initDone);

  function initDone(err, results)
  {
    self._error = err;
    cb();
  }
}

HTMLApi.prototype.show = function(cb)
{
  var self = this;
  async.auto({
    render:                     this.render.bind(this)         ,
    filters:    ['render',      this.filterInit.bind(this)    ],
  }, showDone);

  function showDone(err, results)
  {
    if ( err )
    {
    }

    if ( self._error )
    {
      $('#header-body').css('display','none');
      $('#header-error').css('display','');
    }
    else
    {
      $('#header-body').css('visibility','visible');
    }

    if ( cb )
      cb();
  }
}

HTMLApi.prototype.showModal = function(body,opt,cb)
{
  var self = this;

  if ( !this.onKeys )
  {
    this.onKeys = function(e) {
      if ( e.keyCode == 13 )
      {
        // Find the first primary button and click it
        var actions = self._reqModal._actions;
        for (var i = 0 ; i < actions.length ; i++ )
        {
          if ( actions[i].primary )
          {
            self.modalAction(actions[i].id);
            return false;
          }
        }
      }
      else if ( e.keyCode == 27 )
      {
        var actions = self._reqModal._actions;
        for (var i = 0 ; i < actions.length ; i++ )
        {
          if ( actions[i].cancel )
          {
            self.modalAction(actions[i].id);
            return false;
          }
        }
      }

      return true;
    }.bind(this);
  }


  this.hideModal();

  if ( !body )
  {
    body = '<div class="loading"></div>';
  }

  opt.body = body;

  var modalHtml = Handlebars.templates['modal.hbs'](opt);
  var modal = $(modalHtml);
  this._reqModal = modal;
  $('.modal-dialog',modal).css('width',opt.width||'750px');
  this.setModalActions(opt.actions);
  modal.bind('keydown', this.onKeys);
  modal.modal({backdrop: 'static', keyboard: false});

  if ( cb )
  {
    modal.on('shown.bs.modal', function() { cb(modal); });
  }

}

HTMLApi.prototype.replaceModal = function(html)
{
  $('.modal-body', this._reqModal).html(html);
}

HTMLApi.prototype.modalAction = function(id) {
  var action;
  this._reqModal._actions.forEach(function(candidate) {
    if ( candidate.id == id )
      action = candidate;
  });

  if ( action && action.onClick)
  {
    action.onClick();
    return false;
  }
  else if ( action && action.cancel )
  {
    this.hideModal();
  }
}

HTMLApi.prototype.hideModal = function() {
  var self = this;
  var old = self._reqModal;
  self._reqModal = null;

  if ( !old )
    return;

  old.unbind('keydown', self.onKeys);
  old.modal('hide');
  old.on('hidden.bs.modal', function() {
    old.remove();
  });
}

HTMLApi.prototype.setModalActions = function(actions)
{
  actions = actions || [];
  this._reqModal._actions = actions;
  var html = '';

  actions.forEach(function(action) {
    var color = 'btn-default';
    var btnType = 'button'
    if ( action.primary ) {
      color = 'btn-primary';
      btnType = 'submit';
    } else if ( action.cancel ) {
      color = 'btn-link';
    }

    html += '<button type="'+btnType+'" class="btn '+color+'" onclick="htmlapi.modalAction(\''+ action.id +'\');">'+ action.text + '</button>';
  });

  $('.modal-footer', this._reqModal).html(html);
}

HTMLApi.prototype.titleUpdate = function(cb)
{
  var title = "API";
  if ( this._data )
    title += ": " + (this._data.displayName || this._data.name || this._data.id || this._data.resourceType || this._data.type);

  document.title = title;

  if ( cb )
    async.nextTick(cb);
}

HTMLApi.prototype.schemasLoad = function(link, cb)
{
  if ( !this._data )
    return async.nextTick(function() { cb("No data") });

  // Link may come from the page <script>, but override it if one is in the JSON body.
  //if ( this._data.links && this._data.links.schemas )
  //  link = this._data.links.schemas;

  if ( link )
  {
    this.ajax('GET', link, function(err,res) {
      if ( err )
        cb("Error loading schema from [" + link + "]: " + err);
      else
        cb(null,res);
    });
  }
  else
  {
    return async.nextTick(function() { cb("No schemas link") });
  }
}


HTMLApi.prototype.schemasMunge = function(cb, results)
{
  var schemas = results.rawSchema;

  if ( !schemas || !schemas.data )
    return async.nextTick(function() { cb("No schema data") });

  var out = {};
  var i, schema;
  for ( i = 0 ; i < schemas.data.length ; i++ )
  {
    schema = schemas.data[i];
    out[schema.id] = this._schemaMunge(schema);
  }

  this._schemas = out;
  return async.nextTick(function() { cb(undefined,out); });
}

HTMLApi.prototype._schemaMunge = function(schema)
{
  // Split complex types like reference[something] into base and sub type
  if ( schema.resourceFields )
  {
    for ( var k in schema.resourceFields )
    {
      this._fieldMunge(schema.resourceFields[k]);
    }
  }

  // Sort filter modifiers
  var filter;
  var order = {'': 1, 'eq':2, 'ne': 3, 'lte':4, 'lt':5, 'gt':6, 'gte':7};
  for ( var k in schema.collectionFilters )
  {
    filter = schema.collectionFilters[k];

    if ( filter && filter.modifiers)
    {
      filter.modifiers.sort(function(a,b) {
        var ia = order[a];
        if ( !ia )
          return 1;

        var ib = order[b];
        if ( !ib )
          return -1;

        return ia-ib;
      });
    }
  }

  return schema;
}

HTMLApi.prototype._fieldMunge = function(field)
{
  field._typeList = field.type.replace(/\]+$/,'').split(/\[/); // vim can't color... ]
  return field;
}

HTMLApi.prototype.docsLoad = function(link, cb, results)
{
  var schemas = results.schema;

  if ( link )
  {
    this.ajax('GET', link, function(err,res) {
      if ( err )
      {
        //cb("Error loading docs from [" + link + "]: " + err);
        cb();
        return;
      }

      res.data.forEach(function(doc) {
        var schema = schemas[doc.id];
        var field;

        if ( !schema )
          return;

        if ( doc.description )
          schema.description = doc.description;

        if ( !doc.resourceFields )
          return;

        var keys = Object.keys(doc.resourceFields);
        var key, field;
        for (var i = 0 ; i < keys.length ; i++ )
        {
          key = keys[i];
          field = doc.resourceFields[key];

          if ( !field || !field.description || !schema.resourceFields[key] )
            continue;

          schema.resourceFields[key].description = field.description;
          schema.resourceFields[key].placeholder = field.placeholder;
        }

      });

      cb(null,res);
    });
  }
  else
  {
    return async.nextTick(function() { cb() });
  }
}

HTMLApi.prototype.render = function(cb)
{
  var data = this._data;
  var jsonHtml = this._formatter.valueToHTML(data)
  var schema = null;
  if ( data.resourceType )
    schema = this.getSchema(data.resourceType);
  else if ( data.type )
    schema = this.getSchema(data.type);

  var operations = {
    up: true,
    reload: true,
  };

  if ( data.type == 'collection' && (data.resourceType||'').toLowerCase() == 'apiversion' )
    operations.up = false;

  if ( schema )
  {
    var methods = ( data.type == 'collection' ? schema.collectionMethods : schema.resourceMethods ) || [];
    var methodMap = {};
    methods.forEach(function(method) {
      operations[ method.toLowerCase() ] = true;
    });

    if ( data.createTypes && Object.keys(data.createTypes).length )
    {
      operations.post = true;
    }
  }

  var actions = {};
  var allActions = {};
  if ( schema )
    allActions = ( data.type == 'collection' ? schema.collectionActions : schema.resourceActions ) || {};

  Object.keys(allActions).sort().forEach(function(key) {
    // Set the action to true if it's available on this object or false if it isn't
    actions[key] = ((data && data.actions) ? !!data.actions[key] : false);
  });

  var tpl = {
    data: this._data,
    docsPage: this._docsPage,
    user: this._user,
    logout: this._logout,
    error: this._error,
    schema: schema,
    operations: operations,
    actions: actions,
    explorer: Cookie.get('debug') || false
  };

  document.body.innerHTML = Handlebars.templates['body.hbs'](tpl);
  $('#json').html(jsonHtml);

  this._addCollapsers();

  $('#filters').html('<span class="inactive">Not available</span>');

  return async.nextTick(cb);
}

HTMLApi.prototype._addCollapsers = function()
{
  var items = $('UL.collapsible');
  for( var i = 0; i < items.length; i++)
  {
    this._addCollapser($(items[i]).parent()[0]);
  }
}

HTMLApi.prototype._addCollapser = function(item)
{
  // This mainly filters out the root object (which shouldn't be collapsible)
  if ( item.nodeName != 'LI' )
    return;

  var collapser = $('<i/>', {
    "class": "glyphicon glyphicon-minus",
    click: JSONFormatter.prototype.collapse
  });

  collapser.insertBefore(item.firstChild);
}

HTMLApi.prototype.getSchema = function(type, obj)
{
  if ( !obj )
    obj = this._data;

  // support this.getSchema() for the top-level resource
  if ( !type && obj )
  {
    if ( obj.type == 'collection' )
      type = obj.resourceType;
    else
      type = obj.type;
  }

  if ( type && this._schemas && this._schemas[type] )
    return this._schemas[type];

  return null;
}

// ----------------------------------------------------------------------------

HTMLApi.prototype.showAction = function(button)
{
  this.actionLoad(button.getAttribute('data-action'), undefined, null);
}

HTMLApi.prototype.actionLoad = function(name, obj, body)
{
  var self = this;

  if ( !obj )
    obj = this._data;

  var isCollection = (obj.type == 'collection');

  // The schema for the type of object we have
  var objSchema = this.getSchema(null,obj);

  // The description of the input and output for this action
  var actionSchema = (isCollection ? objSchema.collectionActions[name] : objSchema.resourceActions[name]);

  // The schema for the input
  var actionInput = {};
  if ( actionSchema.input )
    actionInput = this.getSchema(actionSchema.input);

  // undefined = use the previous body if available
  if ( body === undefined && this._lastRequestBody )
  {
    body = this._lastRequestBody;
  }

  // null = explicitly create a new empty body
  if ( body === null )
  {
    body = {};

    // Apply schema defaults
    for ( k in actionInput.resourceFields )
    {
      v = actionInput.resourceFields[k];
      body[k] = (v['nullable'] ? null : '');
      if ( v['default'] )
      {
        body[k] = v['default'];
      }
    }
  }

  this._lastRequestBody = body;

  this._editSchema = actionInput;
  var url = obj.actions[name];
  var title = 'Action: ' + name;

  self.showModal(null, {title: title}, shown);

  function shown(modal)
  {
    self.loadReferenceOptions(actionInput, ready);

    function ready()
    {
      var rows = [];

      var tpl = {};
      var mode = 'action';
      tpl.fields = self._flattenFields(mode, actionInput, self._lastRequestBody);
      tpl.hasFields = tpl.fields.length > 0;
      tpl.mode = mode;
      tpl.createTypes = false;

      var retry = function()
      {
        self.actionLoad(name, obj);
      }

      var html = Handlebars.templates['edit.hbs'](tpl);
      var popinActions = [
        {id: 'ok',      text: 'Show Request', primary: true, onClick: function() { self.showRequest(mode,'POST',actionInput,retry,url); }.bind(self) },
        {id: 'cancel',  text: 'Cancel', cancel: true }
      ];


      self.replaceModal(html);
      self.setModalActions(popinActions);
      self.editOrActionShown();
    }
  }
}

// ----------------------------------------------------------------------------
HTMLApi.prototype.sortChange = function(elem)
{
  var name = $(elem).val();

  var links = this._data.sortLinks;
  if ( !links && this._data.sort ) {
    links = this._data.sort.links;
  }

  if ( links && links[name] )
    window.location.href = links[name];
}

HTMLApi.prototype.sortOrderChange = function()
{
  if ( this._data.sort && this._data.sort.reverse )
    window.location.href = this._data.sort.reverse;
}

// ----------------------------------------------------------------------------
HTMLApi.prototype.setLimit = function(limit)
{
  var url = URLParse.updateQuery(window.location.href, {limit: limit});
  window.location.href = url;
}

// ----------------------------------------------------------------------------
HTMLApi.prototype.filterInit = function(cb)
{
  var name, list, i, v, modifier, pos;
  var schema = this.getSchema();

  if ( this._data.type != 'collection' || !schema || !schema.collectionFilters )
    return async.nextTick(cb);

  var filters = [];
  var canFilter = false;
  this._filterId = 0;
  if ( this._data.filters )
  {
    for ( name in this._data.filters )
    {
      if ( schema.collectionFilters[name] )
        canFilter = true;

      list = this._data.filters[name];

      if ( !list )
        continue;

      for ( i = 0 ; i < list.length ; i++ )
      {
        v = list[i];
        filters.push({
          id: this._filterId++,
          name: name,
          modifier: (v.modifier == "eq" ? "" : v.modifier) || "",
          value: v.value
        });
      }
    }
  }

  var html = Handlebars.templates['filters.hbs']({
    canFilter: canFilter,
    hasFilters: (filters.length > 0)
  });
  $('#filters').html(html);

  var $elem;
  var options;
  for ( var i = 0 ; i < filters.length ; i++ )
  {
    v = filters[i];

    if ( schema.collectionFilters[v.name] && schema.collectionFilters[v.name].options )
      options = schema.collectionFilters[v.name].options;
    else if ( schema.resourceFields[v.name] && schema.resourceFields[v.name].options )
      options = schema.resourceFields[v.name].options;
    else
      options = null;

    html = Handlebars.templates['filter.hbs']({
      allFilterSchema: schema.collectionFilters,
      thisFilterSchema: schema.collectionFilters[v.name],
      options: options,
      cur: v
    });
    $elem = $(html);
    $('#filter-body').append($elem);
    this.modifierChange($elem);
  }

  async.nextTick(cb);
}

HTMLApi.prototype.filterAdd = function(name, modifier, value, before)
{
  var schema = this.getSchema();
  var schemaFilters = schema.collectionFilters;

  if ( !name )
  {
    // Get the first filter name
    name = Object.keys(schemaFilters)[0];
  }

  if ( !modifier && schemaFilters[name] && schemaFilters[name]['modifiers'] )
  {
    modifier = schemaFilters[name]['modifiers'][0];
  }

  if ( !modifier )
    modifier = 'eq';

  var cur = {
    name:     name,
    modifier: modifier,
    value:    value || ''
  };

  var options = null;
  if ( schema.collectionFilters[name] && schema.collectionFilters[name].options )
    options = schema.collectionFilters[name].options;
  else if ( schema.resourceFields[name] && schema.resourceFields[name].options )
    options = schema.resourceFields[name].options;
  else
    options = null;

  var html = Handlebars.templates['filter.hbs']({
    allFilterSchema: schemaFilters,
    thisFilterSchema: schemaFilters[name],
    options: options,
    cur: cur
  });

  var $elem = $(html);
  if( before )
    $elem = $(before).before($elem);
  else
    $lem = $('#filter-body').append($elem);

  $('#no-filters').hide();
  this.modifierChange($elem);
  return $elem;
}

HTMLApi.prototype.filterRemove = function(elem)
{
  var $div = $(elem).parents('.filter');
  $div.remove();

  var $rows = $('#filter-body DIV');
  $('#no-filters').toggle($rows.length == 0);
}

HTMLApi.prototype.filterModifierChange = function(elem)
{
  var $elem = $(elem);
  var filter = $elem.closest('.filter');
  var input = filter.find('.filter-modifier-input');
  var label = filter.find('.filter-modifier-label');

  input.val(elem.getAttribute('data-value'));
  label.html(elem.getAttribute('data-label'));
  this.modifierChange(filter);
}

HTMLApi.prototype.filterChange = function(elem)
{
  var $elem = $(elem);

  var name = $elem.val();
  var $row = $elem.parents('.filter');
  var prefix = $row.data('prefix');
  var next = $row.next()[0];

  var  modifier = $('#'+prefix+'_modifier').val();
  var  value = $('#'+prefix+'_value').val();

  this.filterRemove(elem);
  $elem = this.filterAdd(name, modifier, value, next);
}

HTMLApi.prototype.modifierChange = function(inElem)
{
  var $elem, $row, prefix;
  if ( inElem.tagName == 'select' )
  {
    $elem = $(inElem);
    $row = $elem.parents('.filter');
    prefix = $row.data('prefix');
  }
  else
  {
    $row = $(inElem);
    prefix = $row.data('prefix');
    $elem = $('#'+prefix+'_modifier');
  }

  var modifier = $elem.val();
  var $input = $('#'+prefix+'_value');
  var on = (modifier != 'null' && modifier != 'notnull');

  $input.toggle(on);
}

HTMLApi.prototype.filterApply = function(clear)
{
  var $rows = $('#filters DIV.filter');
  var $row,prefix,name,modifier,value;

  var query = '';

  if ( !clear )
  {
    for ( var i = 0 ; i < $rows.length ; i++ )
    {
      $row      = $($rows[i]);
      prefix    = $row.data('prefix');
      name      = $('#'+prefix+'_name').val();
      modifier  = $('#'+prefix+'_modifier').val();
      value     = $('#'+prefix+'_value').val();

      // Null/NotNull have no value
      if ( modifier === 'null' || modifier === 'notnull' )
      {
        value = '';
      }
      else  if ( !value )
      {
        // Ignore filters with empty values
        continue;
      }

      // Equals doesn't need an explicit modifier name
      if ( modifier == 'eq' )
        modifier = false;

      query += (query ? '&' : '?') + escape(name) + (modifier ? '_'+modifier : '') + (value ? '=' + escape(value) : '');
    }
  }

  window.location.href = window.location.href.replace(/\?.*$/,'') + query;
}

HTMLApi.prototype.filterClear = function()
{
  this.filterApply(true);
}

// ------------------------------

HTMLApi.prototype.keyFormatter = function(key,obj, path)
{
  var html = this._formatter.jsString(key);

  path = path||[];
  var parentKey = path[path.length-1] || '';

  if ( parentKey == 'createTypes' )
  {
    var schema = this.getSchema(key);
    if ( schema )
    {
      html = '<a class="keylink" href="' + schema.links['self'] + '">' + html + '</a>';
    }
  }
  else if ( parentKey == 'actions' )
  {
    var dataVar = 'htmlapi._data';
    for ( var i = 0 ; i < path.length-1 ; i++ )
    {
      dataVar += "['"+ path[i] + "']";
    }

    html = '<a class="keylink" href="#" onclick="htmlapi.actionLoad(\''+ key + '\',' + dataVar + ',null); return false;">' + html + '</a>';
  }

  return html;
}

HTMLApi.prototype.valueFormatter = function(key,obj, path)
{
  path = (path||[]).slice(0);
  path.push(key);

  var schema = null;
  if ( obj.resourceType )
    schema = this.getSchema(obj.resourceType);
  else if ( obj.type )
    schema = this.getSchema(obj.type);

  var html = this._formatter.valueToHTML(obj[key], path);

  if ( !obj[key] )
    return html;

  if ( key == 'id' && obj.links && obj.links['self'] )
  {
    html = '<a class="valuelink" href="' + obj.links['self'] + '">' + html + '</a>';
  }
  else if ( schema && schema.resourceFields && schema.resourceFields[key] )
  {
    var field = schema.resourceFields[key];
    if ( field._typeList && field._typeList[0] == 'reference' )
    {
      var subtype = this.getSchema(field._typeList[1]);
      if ( subtype && subtype.links.collection )
      {
        var url = subtype.links.collection.replace(/\/+$/,'') + '/' + escape(obj[key]);
        html = '<a class="valuelink" href="' + url + '">' + html + '</a>';
      }
    }
  }
  else if (schema && (key == 'type' || key == 'resourceType') )
  {
    html = '<a class="valuelink" href="' + schema.links['self'] + '">' + html + '</a>';
  }

  return html;
}

HTMLApi.prototype.ajax = function(method, url, body, cb)
{
  method = method || 'GET';

  if ( typeof body == 'function' )
  {
    cb = body;
    body = null;
  }

  if ( body && typeof body == 'object' )
  {
    body = JSON.stringify(body);
  }

  var headers = {
    'Accept' : 'application/json'
  };

  var csrf = Cookie.get('CSRF');
  if ( method != 'GET'  && csrf)
  {
    headers['X-API-CSRF'] = csrf;
  }

  var res;
  res = jQuery.ajax({
    type: method,
    data: body,
    contentType: 'application/json',
    headers: headers,
    url: url,
    dataType: 'json',
    success: function(data, msg, jqxhr) { cb(null,data, jqxhr); },
    error: function(jqxhr, msg, exception) {
      var body = null;
      try {
        body = jQuery.parseJSON(jqxhr.responseText);
      }
      catch (e) {
        body = jqxhr.responseText;
      }

      cb(msg, body, jqxhr);
    }
  });
}

// ------------------------------

HTMLApi.prototype.up = function()
{
  window.location.href = window.location.href.replace(/[^\/]+\/?$/,'');
}

HTMLApi.prototype.reload = function()
{
  window.location.href = window.location.href.replace(/#.*/,'');
}

HTMLApi.prototype.logout = function()
{
  window.location.href = window.location.href.replace(/\/\//,"//logout@");
}

HTMLApi.prototype.request = function(method,body,opt,really)
{
  var self = this;
  method = (method || 'GET').toUpperCase();
  opt = opt || {};

  this._lastOpt = opt;
  this._lastRequestBody = body;
  this._lastMethod = method;

  var url = opt.url;
  if ( !url && this._data.links )
    url = this._data.links.self;

  if ( !url )
  {
    alert("I don't know what URL to send a request to, did you specify a 'self' link?");
    return
  }

  var urlParts = URLParse.parse(url);

  if ( really )
  {
    this.setModalActions([
      {id: 'cancel', text: 'Cancel', cancel: true}
    ]);

    $('#notsent').hide();
    $('#waiting').show();
    $('#result' ).hide();

    if ( opt.blobs )
    {
      var form = new FormData();
      var fields = form.getElementsByTagName('INPUT');
      var field;

      for ( var i = 0 ; i < fields.length ; i++ )
      {
        field = fields[i];
        if ( field.type == 'file' )
          form.append(field.name, field.files[0]);
        else
          form.append(field.name, field.value)
      }

      this.ajax(method, url, form, function(err, body, jqxhr) { self.requestDone(err,body,jqxhr) });
    }
    else
    {
      this.ajax(method, url, body||'', function(err,body,jqxhr) { self.requestDone(err,body,jqxhr); });
    }

    return;
  }

  var tpl = {
    curl_user: this._curlUser,
    method: method,
    host: urlParts.host,
    path: urlParts.requestUri,
    baseUrl: urlParts.protocol+'//'+urlParts.host,
  };

  if ( opt.blobs )
  {
    var rawBody = {};
    var keys = Object.keys(body);
    var key;
    for ( var i = 0 ; i < keys.length ; i++ )
    {
      key = keys[i];
      if ( opt.blobs[i] )
        rawBody[key] = { blob: true, value: body[key] };
      else
        rawBody[key] = { blob: false, value: body[key] };
    }

    var boundary = URLParse.generateHash(16);
    tpl.rawBody = rawBody;
    tpl.boundary = boundary;
    tpl.contentType = 'multipart/form-data; boundary='+ boundary;
  }
  else if ( typeof body == 'object' )
  {
    var json = JSON.stringify(body);
    var formatted = this._formatter.valueToHTML(body);
    tpl.prettyBody = formatted;
    tpl.contentLength = json.length;
    tpl.contentType = 'application/json';
  }

  var html = Handlebars.templates['request.hbs'](tpl);

  var actions = [];

  actions.push({id: 'ok',      text: 'Send Request', primary: true, onClick: function() { self.request(method,body,opt,true); } });

  if ( this._lastOpt && this._lastOpt.retry )
    actions.push({id: 'edit', text: 'Back to Edit', onClick: this._lastOpt.retry.bind(this,body) });

  actions.push({id: 'cancel',  text: 'Cancel', cancel: true});

  self.showModal(html, {
    destroyOnClose: false,
    title: 'API Request',
    actions: actions,
  });
}

HTMLApi.prototype.postDone = function()
{
  var body = $('#post_iframe').contents()[0].body;
  var text = body.innerText || body.textContent;
  var json = JSON.parse(text);
  this.requestDone(undefined,json);
}

HTMLApi.prototype.requestDone = function(err, body, res)
{
  var tpl = {};

  if ( err && !body )
  {
    alert('Error: ' + err);
    return;
  }

  if ( res )
  {
    var headers = [];
    var lines = res.getAllResponseHeaders().trim().split(/\r?\n/);
    var parts;
    for ( var i = 0 ; i < lines.length ; i++ )
    {
      parts = lines[i].splitLimit(':',2);
      headers.push({name: parts[0].trim(), value: parts[1].trim()});
    }

    tpl.res = res;
    tpl.responseHeaders = headers;
  }

  var html = Handlebars.templates['response.hbs'](tpl);

  var out = '';
  var selfUrl = false;
  if ( body )
  {
    if ( typeof body == 'object' )
    {
      if ( body.links && body.links.self )
        selfUrl = body.links.self;

      out = '<div class="json">'+this._formatter.valueToHTML(body)+'</div>';
    }
    else
    {
      out = $('<div/>').text(body.toString()).html();
    }
  }

  var loc;
  if ( res )
  {
    loc = res.getResponseHeader('Location');
  }

  var retry = (this._lastOpt.retry && (res.status >= 400));

  var primary = 'reload';
  var popinActions = [
      {id: 'reload',  text: 'Reload', onClick: this.reload.bind(this)},
      {id: 'up',      text: 'Go Up',  onClick: function() { this.up(); }.bind(this) },
      {id: 'cancel',  text: 'Close',  cancel: true}
  ];

  if ( loc )
  {
    primary = 'follow';
    popinActions.unshift({id: 'follow', text: 'Follow Location', onClick: function() { window.location.href = loc }});
  }
  else if ( selfUrl )
  {
    primary = 'followSelf';
    popinActions.unshift({id: 'followSelf', text: 'Follow Self Link', onClick: function() { window.location.href = selfUrl }});
  }

  if ( retry )
  {
    primary = 'edit';
    popinActions.unshift({id: 'edit', text: 'Edit & Retry', onClick: this._lastOpt.retry.bind(this) });
  }

  // Default to "Go Up" on successful delete
  if ( (this._lastMethod||"").toUpperCase() == 'DELETE' && res.status >= 200 && res.status <= 299)
  {
    primary = 'up';
  }

  for ( var i = 0 ; i < popinActions.length ; i++ )
  {
    if ( popinActions[i].id == primary )
    {
      popinActions[i].primary = true;
      break;
    }
  }

  this.setModalActions(popinActions);
  $('#notsent').hide();
  $('#waiting').hide();
  $('#result').html(html);
  $('#response-body').html(out);
  $('#result' ).show();
}

HTMLApi.prototype.create = function()
{
  var self = this;
  var data = {};
  var k, v;
  var schema = this.getSchema();

  // Apply schema defaults
  for ( k in schema.resourceFields )
  {
    v = schema.resourceFields[k];
    data[k] = (v['nullable'] ? null : '');
    if ( v['default'] )
    {
      data[k] = v['default'];
    }
  }

  // Apply response defaults
  if ( this._data.createDefaults )
  {
    for ( k in this._data.createDefaults )
    {
      data[k] = this._data.createDefaults[k];
    }
  }

  this._lastMode = 'create';
  if ( this._data.createTypes )
  {
    // Make sure the selected type exists in the createTypes list
    var type = data.type;
    if ( !type || !this._data.createTypes[type] )
      type = Object.keys(this._data.createTypes)[0];

    this._lastType = type;
    this._lastRequestBody = data;
    this.createTypeChanged(type,true);
  }
  else
  {
    this.showEdit(data, false, schema);
  }
}

HTMLApi.prototype.loadReferenceOptions = function(schema,doneCb)
{
  var self = this;

  function getReferences(task, cb)
  {
    function gotReferences(err,res)
    {
      if ( res.pagination && res.pagination.partial )
      {
        // Too many...
      }
      else
      {
        var opt = {};
        var i, obj, label;
        for ( i = 0 ; i < res.data.length ; i++ )
        {
          obj = res.data[i];
          if ( obj.displayName )
            label = obj.displayName + ' (' + obj.id + ')';
          else if ( obj.name )
            label = obj.name + ' (' + obj.id + ')';
          else
            label = obj.id;

          opt[ obj.id ] = label;
        }

        schema.resourceFields[task.field].options = opt;
      }

      cb();
    }

    self.ajax('GET', URLParse.updateQuery(task.url,{limit: self._referenceDropdownLimit}), gotReferences);
  }

  var q = async.queue(getReferences, 1);
  q.drain = doneCb;

  var k, field, idxj;
  for ( k in schema.resourceFields )
  {
    field = schema.resourceFields[k];
    idx = field._typeList.indexOf('reference');
    if ( idx >= 0 )
    {
      if ( field.referenceCollection )
      {
        // Explicit collection URL to load
        q.push({field: k, url: field.referenceCollection});
      }
      else if ( field._typeList[idx+1] )
      {
        // Look for a collection URL in the schema for the referenced type
        var referenceSchema = this.getSchema(field._typeList[idx+1]);
        if ( referenceSchema && referenceSchema.links.collection)
        {
          q.push({field: k, url: referenceSchema.links.collection});
        }
      }
    }
  }

  if ( q.length() == 0 )
    q.drain();
}


HTMLApi.prototype.showEdit = function(data,update,schema,url)
{
  var self = this;
  if ( !schema )
  {
    return;
  }

  var mode = (update ? 'update' : 'create');

  this.loadReferenceOptions(schema, display);
  this._editSchema = schema;
  this._editData = data;

  function display()
  {
    var rows = [];

    var tpl = {};
    tpl.description = schema.description;
    tpl.fields = self._flattenFields(mode, schema, data);
    tpl.hasFields = tpl.fields.length > 0;
    tpl.mode = mode;
    tpl.createTypes = self._data.createTypes || false;

    if ( self._data.createTypes && Object.keys(self._data.createTypes).length > 1 )
    {
      var typeField = {
        required: true,
        create: true,
        type: '__type__',
        _typeList: ['__type__'],
        options: Object.keys(self._data.createTypes)
      };

      tpl.typeField = self._flattenField('create', 'type', typeField, self._lastType, 0);
    }

    var retry = function(body)
    {
      self.showEdit(body||self._lastRequestBody||data, update, schema, url);
    }

    var title = (update ? 'Edit' : 'Create') +' '+ schema.id;
    var html = Handlebars.templates['edit.hbs'](tpl);
    var method = (update ? 'PUT' : 'POST');
    var popinActions = [
      {id: 'ok',      text: 'Show Request', primary: true, onClick: function() { self.showRequest(mode, method,schema,retry,url); }.bind(self) },
      {id: 'cancel',  text: 'Cancel', cancel: true }
    ];

    self.showModal(html, {
        title: title,
        actions: popinActions
    }, self.editOrActionShown.bind(self));
  }
}

HTMLApi.prototype.editOrActionShown = function() {
  var self = this;

  // Focus the first regular input
  var input = $(":input:not(input[type=button],input[type=submit],button):visible:first", htmlapi._reqModal);
  if ( input )
    input.focus();

  // Make the null checkboxes clear the field, and field clear null
  $(htmlapi._reqModal).on('keyup','input[type="text"], input[type="number"], input[type="password"], textarea', onChange);
  $(htmlapi._reqModal).on('change','input[type="text"], input[type="number"], input[type="password"], textarea', onChange);

  $('.tip').tooltip({placement: 'right'});

  function onChange(event) {
    if ( event.keyCode < 32 )
      return;

    var selector = 'INPUT[name="'+ event.target.name + self._magicNull + '"]';
    var checks = $(selector, htmlapi._reqModal)
    if ( checks && checks[0] )
      checks[0].checked = false;
  }
}

HTMLApi.prototype._escapeRegex = function(str)
{
  return str.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'); // vim... ]
}

HTMLApi.prototype._flattenFields = function(mode,schema,data)
{
  var rows = [];

  if ( !schema || !schema.resourceFields )
    return [];

  var keys = Object.keys(schema.resourceFields);
  var name, field, row;
  for ( var i = 0 ; i < keys.length ; i++ )
  {
    name = keys[i];
    field = schema.resourceFields[name];

    if ( name == "type" )
      continue;

    row = this._flattenField(mode, name, field, data[name]);
    if ( row )
      rows.push(row);
  }

  return rows;
}

HTMLApi.prototype._flattenField = function(mode, name, field, data, depth)
{
  if ( (mode != 'update') && (mode != 'action') && !(mode == 'create' && field.create) )
  {
    // This field is not set/changeable
    return null;
  }

  depth = depth || 0;

  var type = field._typeList[depth];

  var isEmbedded = false;
  if ( ['string','password','float','int','date','blob','boolean','enum','reference','array','map'].indexOf(type) === -1 && this.getSchema(type) )
  {
    // Show embedded types as JSON, until proper support for embedded types is added.
    type = 'json';
    isEmbedded = true;
  }


  // The value input's name
  var formFieldName = 'field_'+name;

  // The key input's name, for maps
  var formFieldName2 = null;
  var subType;
  for ( var i = 0 ; i <= depth; i++ )
  {
    subType = field._typeList[i];
    if ( subType == 'array' )
    {
      formFieldName += '[]';
    }
    else if ( subType == 'map' )
    {
      formFieldName2 = formFieldName+'.key{}';
      formFieldName += '.value{}';
    }

    if ( subType == 'json' || (isEmbedded && i === depth) )
    {
      formFieldName += '.json{}';
    }
  }

  var row = {
    name: name,
    formFieldName: formFieldName,
    formFieldName2: formFieldName2,
    formFieldNameNull: formFieldName+this._magicNull,
    required: field.required || false,
    writable: (mode == 'action') || (mode == 'update' && field.update) || (mode != 'update' && field.create),
    description: field.description,
    placeholder: field.placeholder||"",
    enlargeable: (type == 'string' && (!field.maxLength || field.maxLength > 63)),
    nullCheck: (field.nullable && !field.options && ['string','data','password','number','int','float','reference'].indexOf(field.type) >= 0 ),
    type: type,
    field: field,
    children: null,
    value: ''
  };

  var displayType = field._typeList[ field._typeList.length - 1];
  var parentType  = field._typeList[ field._typeList.length - 2];
  if ( isEmbedded || (parentType && (parentType == 'reference' || parentType == 'array' || parentType == 'map')) )
  {
    var link = null;
    if ( field.referenceCollection )
    {
      link = field.referenceCollection;
    }
    else
    {
      var displaySchema = this.getSchema(displayType);
      if ( displaySchema )
      {
        link = displaySchema.links['collection'] || displaySchema.links['self'];
      }
    }

    if ( link )
    {
      displayType = '<a tabindex="-1" href="' + link + '" target="_blank">' + displayType + '</a>';
    }
  }

  for ( var i = field._typeList.length - 2 ; i >= depth ; i-- )
  {
    displayType = field._typeList[i] + '[' + displayType + ']';
  }

  row.displayType = displayType;

  if ( type == 'map' )
  {
    row.children = [];
    var keys = Object.keys(data||{});
    var child;
    for ( var i = 0 ; i < keys.length ; i++ )
    {
      child = this._flattenField(mode, name, field, data[keys[i]], depth+1);
      child.value2 = keys[i];
      child.parentIsMap = true;
      row.children.push(child);
    }
  }
  else if ( type == 'array' )
  {
    row.children = [];
    for ( var i = 0 ; i < (data||[]).length ; i++ )
    {
      row.children.push( this._flattenField(mode, name, field, data[i], depth+1) );
    }
  }
  else if ( type == 'json' )
  {
    row.value = JSON.stringify(data);
  }
  else
  {
    row.value = data;
  }

  return row;
}


HTMLApi.prototype.remove = function(really)
{
  this.request('DELETE');
}

HTMLApi.prototype.update = function()
{
  var schema = this.getSchema(this._data.type);

  var data = {};
  var k, v;
  for ( k in schema.resourceFields )
  {
    data[k] = this._data[k];
  }

  this.showEdit(data, true, schema)
}

HTMLApi.prototype.createTypeChanged = function(type,first)
{
  var self = this;
  var schema = this.getSchema(type);

  // Save the current values
  if ( first !== true )
  {
    var values = self.getFormValues(self._lastMode, null, schema);
    self._lastRequestBody = values.body;
  }

  self._lastType = type;
  self.showEdit(self._lastRequestBody, false, schema, this._data.createTypes[type] );
}

HTMLApi.prototype._flattenInputs = function($form)
{
  var i, j;
  var serialized = $form.serializeArray();

  // serializeArray doesn't include unchecked checkboxes... so add those.
  var checkboxes = $("input:checkbox:not(:checked)",$form);
  var check;
  for ( i = 0 ; i < checkboxes.length ; i++ )
  {
    check = checkboxes[i];

    // But ignore the magic null checkboxes
    if ( check.name.match(this._magicNullRegex) )
      continue;

    serialized.push({name: check.name, value: false});
  }

  var $files = $("INPUT[type='file']",$form);
  for ( i = 0 ; i < $files.length ; i++ )
  {
    serialized.push({name: $files[i].name, value: $($files[i]).val()});
  }

  var inputs = {};
  var k, field, v;
  var isArray, isMapKey, isMapValue, isJsonValue, name, values;

  var maps = {};

  for ( i = 0 ; i < serialized.length ; i++ )
  {
    field = serialized[i];
    k = field.name.replace(/^field_/,'');
    v = field.value;
    isArray = k.indexOf('[]') >= 0;
    isMapKey = k.indexOf('.key{}') >= 0;
    isMapValue = k.indexOf('.value{}') >= 0;
    isJsonValue = k.indexOf('.json{}') >= 0;

    name = k;
    if ( isJsonValue )
      name = name.replace(/\.json\{\}$/,'');
    if ( isMapKey )
      name = name.replace(/\.key\{\}$/,'');
    if ( isMapValue )
      name = name.replace(/\.value\{\}$/,'');
    if ( isArray )
      name = name.replace(/\[\]$/,'');

    if ( isJsonValue )
    {
      try {
        if (v) {
          v = JSON.parse(v);
        } else {
          v = null
        }
      }
      catch(e)
      {
        alert(e + ' in ' + name);
      }
    }

    if ( isArray )
    {
      if ( typeof inputs[name] === "undefined" )
        inputs[name] = [];

      inputs[name].push(v);
    }
    else if ( isMapKey || isMapValue )
    {
      if ( typeof maps[name] === 'undefined' )
      {
        maps[name] = {keys: [], values: []};
      }

      if ( isMapKey )
        maps[name].keys.push(v);
      if ( isMapValue )
        maps[name].values.push(v);
    }
    else if ( isJsonValue )
    {
      inputs[name] = v;
    }
    else
    {
      inputs[k] = v;
    }
  }

  var keys = Object.keys(maps);
  var map, subK;
  for ( i = 0 ; i < keys.length ; i++ )
  {
    k = keys[i];
    map = maps[k];
    inputs[k] = {};

    for ( j = 0 ; j < map.keys.length ; j++ )
    {
      subK = map.keys[j];
      if ( subK )
        inputs[k][subK] = map.values[j];
    }
  }

  return inputs;
}

HTMLApi.prototype.getFormValues = function(mode, method, schema)
{
  var $form = $('#edit-form')
  var inputs = this._flattenInputs($form);

  var body = {};
  var blobs = null;
  var k, field, v;
  var isNull;
  for ( k in schema.resourceFields )
  {
    field = schema.resourceFields[k];
    v = inputs[k];

    // Ignore the null checkboxes
    if ( k.match(this._magicNullRegex) )
      continue;

    // Don't send fields that can't be set on create
    if ( mode == 'create' && !field.create )
      continue;

    // Set the value to the magicNull if the checkbox is checked
    if ( inputs[k+this._magicNull] )
      v = this._magicNull;

    if ( field._typeList[0] == 'array' )
    {
      // Make sure it's an array
      if ( !v || v.length == 0 )
        v = [];

      // Remove empty items
      for ( var i = v.length ; i >= 0 ; i-- )
      {
        if ( v[i] === "" )
        {
          v.splice(i,1);
        }
      }
    }

    if ( v === this._magicNull )
    {
      // Don't send nullable fields if null, unless the current value is not null
      if ( field.nullable && this._editData && !this._editData[k] )
        continue;
      else
        v = null;
    }

    if ( field.type == 'blob' )
    {
      if ( v )
      {
        var filename = this.extractFilename(v);
        if ( !blobs )
        {
          blobs = {};
        }
        blobs[k] = 1;
        body[k] = filename;
      }
    }
    else if ( field.type == 'boolean' )
    {
      if ( typeof v != 'undefined')
      {
        if ( field.nullable && v === null )
        {
          body[k] = null;
        }
        else
        {
          body[k] = (v == 1);
        }
      }
    }
    else if ( field.type == 'int' && v !== null)
    {
      body[k] = parseInt(v,10)||0;
    }
    else if ( field.type == 'float' && v !== null)
    {
      body[k] = parseFloat(v)||0;
    }
    else if ( typeof v != 'undefined' )
    {
      body[k] = v;
    }
    else if ( method == 'PUT' && typeof this._data[k] != 'undefined' )
    {
      // Copy fields from the original for edit
      body[k] = this._data[k];
    }
  }

  return {
    body: body,
    blobs: blobs
  };
}

HTMLApi.prototype.showRequest = function(mode, method, schema, retry, url)
{
  var values = this.getFormValues(mode,method,schema);

  var opt = {blobs: values.blobs};

  if ( retry )
    opt.retry = retry;

  if ( url )
    opt.url = url;

  this.request(method, values.body, opt);
}

HTMLApi.prototype.extractFilename = function(path)
{
  var sep = /[\/\\:]/;  // If nothing matches, use the any of the delimiters
  if ( path.match(/^\\/) || path.match(/^[^\\]:\\/) )
  {
    sep = "\\";
  }
  else if ( path.match(/^\//) )
  {
    sep = "/";
  }
  else if ( path.match(":") )
  {
    sep = ":";
  }

  var parts = path.split(sep);
  return parts[parts.length-1];
}

HTMLApi.prototype.subAdd = function(button, name)
{
  var schema = this._editSchema;
  var schemaField = schema.resourceFields[name];

  var parentField = this._flattenField('update',name,schemaField,{},0);

  var field = this._flattenField('update',name,schemaField,'',1);
  field.parentIsMap = parentField.type == 'map';
  field.enlargeable = false;
  if ( field.type == 'json' )
    field.value = '{}';

  var par = {
    type: parentField.type,
    addingField: true,
    children: [field]
  }

  var html = Handlebars.partials['field.hbs'](par);

//  html = '<div><input type="button" onclick="htmlapi.subRemove(this);" value="-">' + html + '</div>';
  $(button).before(html);
}

HTMLApi.prototype.subRemove = function(button)
{
  var $div = $(button).parents('DIV');
  $($div[0]).remove();
}

HTMLApi.prototype.toggleNull = function(check)
{
  var $check = $(check);
  var name = check.name.replace(this._magicNullRegex,'');
  var selector = 'INPUT[name="'+ name +'"], TEXTAREA[name="'+ name +'"]';
  var $input = $(selector, htmlapi._reqModal);

  if ( !$input || !$input[0] )
    return;

  if ( check.checked )
    $input.val('');
  else
    $input[0].focus();
}

HTMLApi.prototype.switchToTextarea = function(button)
{
  var $button = $(button);
  var $par = $($button.parent());
  var $input = $('INPUT[type="text"]', $par);

  if ( !$input[0] )
    return;

  var val = $input.val();

  var $textarea = $('<textarea>', {name: $input.attr('name') }).addClass('expandedTextarea');
  $input.replaceWith($textarea);
  $textarea.val(val);
  $textarea.on('keydown', function(e) { if ( e.keyCode == 13 ) { e.stopPropagation(); return true; } });
  $button.hide();
}

HTMLApi.prototype.setLocalCookie = function(on,min) {
  if ( on === false )
  {
    Cookie.remove('js.url');
    Cookie.remove('css.url');
  }
  else
  {
    var base = 'http://localhost:3000/ui' + (min === true ? '.min' : '');
    Cookie.set('js.url', base + '.js', 3650);
    Cookie.set('css.url', base + '.css', 3650);
  }
}
