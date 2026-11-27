# Runs only in the dedicated local acceptance container.
require 'json'
require 'securerandom'

raise 'Use the local SQLite pilot' unless Rails.configuration.database_configuration.dig('production', 'database') == 'sqlite/redmine.db'

passwords = JSON.parse(STDIN.read)
result = ActiveRecord::Base.transaction do
  Redmine::DefaultData::Loader.load('en') if Tracker.count.zero?
  Setting.rest_api_enabled = '1'
  Setting.login_required = '1'
  project = Project.find_or_initialize_by(identifier: 'softline-pilot')
  project.name = 'Softline local pilot'
  project.is_public = false
  project.enabled_module_names = ['issue_tracking']
  project.trackers = Tracker.all
  project.save!

  field = IssueCustomField.find_or_initialize_by(name: 'Происхождение задачи')
  field.field_format = 'list'
  field.possible_values = ['ai-generated']
  field.is_filter = true
  field.is_required = false
  field.visible = true
  field.editable = true
  field.tracker_ids = project.tracker_ids
  field.project_ids = [project.id]
  field.save!

  keys = {}
  %w[writer reader].each do |name|
    user = User.find_or_initialize_by(login: "pilot-#{name}")
    if user.new_record?
      user.firstname = 'Pilot'
      user.lastname = name.capitalize
      user.mail = "#{name}@pilot.invalid"
    end
    password = passwords.fetch(name)
    user.password = password unless user.persisted? && user.check_password?(password)
    user.save!
    role = Role.find_by!(name: name == 'writer' ? 'Manager' : 'Reporter')
    member = Member.find_or_initialize_by(project: project, user: user)
    member.roles = [role]
    member.save!
    keys["#{name}Key"] = user.api_key
  end
  # Replace the image's initial administrator password on this dedicated stand.
  admin = User.find_by(login: 'admin')
  if admin && admin.check_password?('admin')
    admin.password = SecureRandom.hex(40)
    admin.save!
  end
  keys.merge(url: 'https://localhost:18443', scope: project.identifier, originFieldId: field.id.to_s)
end
puts JSON.generate(result)
