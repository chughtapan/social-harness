(norm hold-then-confirm
  :description "The client asks the server for a meeting about a topic. The server offers slots, and the client returns every option it can attend. The server holds the request and gives a delay in seconds. The client checks back after that delay using its host's scheduling tools. The server then books and confirms a selected slot, offers revised slots, or explains why the request cannot be completed. At most two offers occur in one request.")

(act request :by client :starts true :sets (open offer-due)
  (field topic :type string :min-length 1 :max-length 300
    :description "The subject to discuss. Dates that belong to the subject are allowed; meeting times, availability and counteroffers are not."))
(act propose :by server :when offer-due :max 2
  :clears (offer-due decision-due) :sets offered
  (field options :type list :min-items 2 :max-items 3 :format date-time)
  (field length :type string :format duration))
(act accept-proposal :by client :when offered
  :clears offered :sets hold-due
  (field available :type list :min-items 1 :format date-time)
  (relation subset available (previous propose options)))
(act reject-proposal :by client :when offered
  :clears offered :sets offer-due)
(act agree :by server :when hold-due
  :clears hold-due :sets held
  (field recheck-after :type integer :minimum 5 :maximum 60
    :description "Seconds before the client checks back."))
(act query-if :by client :when held
  :after (held recheck-after)
  :clears held :sets (decision-due offer-due))
(act confirm :by server :when decision-due :ends true
  (field slot :type string :format date-time)
  (relation member slot (previous accept-proposal available)))
(act failure :by server :when open :ends true
  (field reason :type string :min-length 1 :max-length 300
    :description "Why this request cannot be completed or needs the attention of the server's owner. It does not tell the client to start a new request to get around the offer limit."))
(act not-understood :by (client server) :when open
  :clears (offered hold-due held decision-due) :sets offer-due
  (field reason :type string :min-length 1
    :description "What was wrong with the act it answers or with the order of acts. It carries no counteroffer and no availability."))
