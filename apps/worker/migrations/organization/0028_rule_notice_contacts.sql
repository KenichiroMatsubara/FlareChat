ALTER TABLE `rules` ADD `notice_contact_list_id` text REFERENCES contact_lists(id);
