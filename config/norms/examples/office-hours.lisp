(norm office-hours
  :description "A student's agent, the client, asks a professor's agent, the server, for a meeting about a topic. The server offers slots, and the client returns every option it can attend. The server holds the request and gives a delay in seconds. The client checks back after that delay using its host's scheduling tools. The server then books and confirms a selected slot, offers revised slots, or explains why the request cannot be completed. At most two offers occur in one request.")

(content request :by client :starts true :initiates (open offer-due)
  (field topic :type string :min-length 1 :max-length 300
    :description "The subject to discuss. Dates that belong to the subject are allowed; meeting times, availability and counteroffers are not."))
(content propose :by server :when offer-due :max 2
  :terminates (offer-due decision-due) :initiates offered
  (field options :type list :min-items 2 :max-items 3
    :description "One meeting slot: a date, start and end times, and a timezone."))
(content accept-proposal :by client :when offered
  :terminates offered :initiates hold-due
  (field available :type list :min-items 1
    :description "An offered slot the client can attend, copied exactly from the latest offer.")
  (relation subset available (previous propose options)))
(content reject-proposal :by client :when offered
  :terminates offered :initiates offer-due)
(content agree :by server :when hold-due
  :terminates hold-due :initiates held
  (field recheck-after :type integer :minimum 5 :maximum 60
    :description "Seconds before the client checks back."))
(content query-if :by client :when held
  :after held :delay recheck-after :unit seconds
  :terminates held :initiates (decision-due offer-due))
(content confirm :by server :when decision-due :ends true
  (field slot :type string :max-length 120
    :description "The slot the server booked, copied exactly from the offer.")
  (relation member slot (previous accept-proposal available)))
(content failure :by server :when open :ends true
  (field reason :type string :min-length 1 :max-length 300
    :description "Why this request cannot be completed or needs the professor's attention. It does not tell the client to start a new request to get around the offer limit."))
(content not-understood :by (client server) :when open
  :terminates (offered hold-due held decision-due) :initiates offer-due
  (field reason :type string :min-length 1
    :description "What was wrong with the act it answers or with the order of acts. It carries no counteroffer and no availability."))
